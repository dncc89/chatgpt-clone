const axios = require('axios');
const crypto = require('crypto');
const TextStream = require('../stream');
const { Agent, ProxyAgent } = require('undici');
const { getMessages, saveMessage, saveConvo } = require('../../models');
const {
  encoding_for_model: encodingForModel,
  get_encoding: getEncoding
} = require('@dqbd/tiktoken');

const tokenizersCache = {};

class LlamaClient {
  constructor(credentials, options = {}) {
    this.client_email = credentials.client_email;
    this.project_id = credentials.project_id;
    this.private_key = credentials.private_key;
    this.setOptions(options);
    this.currentDateString = new Date().toLocaleDateString('en-us', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }

  setOptions(options) {
    if (this.options && !this.options.replaceOptions) {
      // nested options aren't spread properly, so we need to do this manually
      this.options.modelOptions = {
        ...this.options.modelOptions,
        ...options.modelOptions
      };
      delete options.modelOptions;
      // now we can merge options
      this.options = {
        ...this.options,
        ...options
      };
    } else {
      this.options = options;
    }


    const modelOptions = this.options.modelOptions || {};
    this.modelOptions = {
      ...modelOptions,
      // set some good defaults (check for undefined in some cases because they may be 0)
      model: modelOptions.model || 'ggml-vicuna1.17b-q5_1.bin',
      temperature: typeof modelOptions.temperature === 'undefined' ? 0.2 : modelOptions.temperature, // 0 - 1, 0.2 is recommended
      topP: typeof modelOptions.topP === 'undefined' ? 0.95 : modelOptions.topP, // 0 - 1, default: 0.95
      topK: typeof modelOptions.topK === 'undefined' ? 40 : modelOptions.topK // 1-40, default: 40
      // stop: modelOptions.stop // no stop method for now
    };


    this.maxContextTokens = this.options.maxContextTokens || 2048;
    // The max prompt tokens is determined by the max context tokens minus the max response tokens.
    // Earlier messages will be dropped until the prompt is within the limit.
    this.maxResponseTokens = this.modelOptions.maxOutputTokens || 1024;
    this.maxPromptTokens =
      this.options.maxPromptTokens || this.maxContextTokens - this.maxResponseTokens;

    if (this.maxPromptTokens + this.maxResponseTokens > this.maxContextTokens) {
      throw new Error(
        `maxPromptTokens + maxOutputTokens (${this.maxPromptTokens} + ${this.maxResponseTokens} = ${this.maxPromptTokens + this.maxResponseTokens
        }) must be less than or equal to maxContextTokens (${this.maxContextTokens})`
      );
    }

    this.userLabel = this.options.userLabel || 'User';
    this.modelLabel = this.options.modelLabel || 'Assistant';
    this.completionsUrl = process.env.GPT_LLAMA_URL;
    this.gptEncoder = this.constructor.getTokenizer('cl100k_base');
    return this;
  }

  static getTokenizer(encoding, isModelName = false, extendSpecialTokens = {}) {
    if (tokenizersCache[encoding]) {
      return tokenizersCache[encoding];
    }
    let tokenizer;
    if (isModelName) {
      tokenizer = encodingForModel(encoding, extendSpecialTokens);
    } else {
      tokenizer = getEncoding(encoding, extendSpecialTokens);
    }
    tokenizersCache[encoding] = tokenizer;
    return tokenizer;
  }


  buildPayload(input, { messages }) {
    const conversation = {
      messages: messages.map((message, index) => {
        return { role: index % 2 === 0 ? "system" : "user", content: message };
      }),
    };
    conversation.messages.push({ role: "user", content: input });

    if (this.options.promptPrefix) {
      conversation.messages.unshift({ role: "system", content: this.options.promptPrefix });
    }

    return {
      messages: conversation.messages,
      max_tokens: 150, // limit response length
      temperature: 0.8, // control randomness
    };
  }

  async getCompletion(input, messages = [], abortController = null) {
    if (!abortController) {
      abortController = new AbortController();
    }
    const { debug } = this.options;
    const url = this.completionsUrl;
    const payload = this.buildPayload(input, { messages });

    try {
      const res = await axios({
        url: url,
        method: 'POST',
        data: payload,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GPT_LLAMA_LOCATION + this.modelOptions.model}`
        },
        signal: abortController?.signal,
      });

      console.dir(res.data, { depth: null });
      return res.data;
    } catch (error) {
      console.error(error);
      throw error;  // Or handle the error as you see fit.
    }
  }

  async loadHistory(conversationId, parentMessageId = null) {
    if (this.options.debug) {
      console.debug('Loading history for conversation', conversationId, parentMessageId);
    }

    if (!parentMessageId) {
      return [];
    }

    const messages = (await getMessages({ conversationId })) || [];

    if (messages.length === 0) {
      this.currentMessages = [];
      return [];
    }

    const orderedMessages = this.constructor.getMessagesForConversation(messages, parentMessageId);
    return orderedMessages.map((message) => {
      const author = message.isCreatedByUser ? this.userLabel : this.modelLabel;
      const content = message.content;
      return `${author}: ${content}`;
    });
  }

  async saveMessageToDatabase(message, user = null) {
    await saveMessage({ ...message, unfinished: false });
    await saveConvo(user, {
      conversationId: message.conversationId,
      endpoint: 'llama',
      ...this.modelOptions
    });
  }

  async sendMessage(message, opts = {}) {
    if (opts && typeof opts === 'object') {
      this.setOptions(opts);
    }
    console.log('sendMessage', message, opts);

    const user = opts.user || null;
    const conversationId = opts.conversationId || crypto.randomUUID();
    const parentMessageId = opts.parentMessageId || '00000000-0000-0000-0000-000000000000';
    const userMessageId = crypto.randomUUID();
    const responseMessageId = crypto.randomUUID();
    const messages = await this.loadHistory(conversationId, this.options?.parentMessageId);

    const userMessage = {
      messageId: userMessageId,
      parentMessageId,
      conversationId,
      sender: 'User',
      text: message,
      isCreatedByUser: true
    };

    if (typeof opts?.getIds === 'function') {
      opts.getIds({
        userMessage,
        conversationId,
        responseMessageId
      });
    }

    console.log('userMessage', userMessage);

    await this.saveMessageToDatabase(userMessage, user);
    let reply = '';
    let blocked = false;
    try {
      const result = await this.getCompletion(message, messages, opts.abortController);
      blocked = result?.predictions?.[0]?.safetyAttributes?.blocked;
      reply = result?.choices?.[0]?.message?.content ||
        '';
      if (blocked === true) {
        reply = `Google blocked a proper response to your message:\n${JSON.stringify(
          result.predictions[0].safetyAttributes
        )}${reply.length > 0 ? `\nAI Response:\n${reply}` : ''}`;
      }
      if (this.options.debug) {
        console.debug('result');
        console.debug(result);
      }
    } catch (err) {
      console.error(err);
    }

    if (this.options.debug) {
      console.debug('options');
      console.debug(this.options);
    }

    if (!blocked) {
      const textStream = new TextStream(reply, { delay: 0.5 });
      await textStream.processTextStream(opts.onProgress);
    }

    const responseMessage = {
      messageId: responseMessageId,
      conversationId,
      parentMessageId: userMessage.messageId,
      sender: 'LLaMa',
      text: reply,
      error: blocked,
      isCreatedByUser: false
    };

    await this.saveMessageToDatabase(responseMessage, user);
    return responseMessage;
  }

  getTokenCount(text) {
    return this.gptEncoder.encode(text, 'all').length;
  }

  /**
   * Algorithm adapted from "6. Counting tokens for chat API calls" of
   * https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb
   *
   * An additional 2 tokens need to be added for metadata after all messages have been counted.
   *
   * @param {*} message
   */
  getTokenCountForMessage(message) {
    // Map each property of the message to the number of tokens it contains
    const propertyTokenCounts = Object.entries(message).map(([key, value]) => {
      // Count the number of tokens in the property value
      const numTokens = this.getTokenCount(value);

      // Subtract 1 token if the property key is 'name'
      const adjustment = key === 'name' ? 1 : 0;
      return numTokens - adjustment;
    });

    // Sum the number of tokens in all properties and add 4 for metadata
    return propertyTokenCounts.reduce((a, b) => a + b, 4);
  }

  /**
   * Iterate through messages, building an array based on the parentMessageId.
   * Each message has an id and a parentMessageId. The parentMessageId is the id of the message that this message is a reply to.
   * @param messages
   * @param parentMessageId
   * @returns {*[]} An array containing the messages in the order they should be displayed, starting with the root message.
   */
  static getMessagesForConversation(messages, parentMessageId) {
    const orderedMessages = [];
    let currentMessageId = parentMessageId;
    while (currentMessageId) {
      // eslint-disable-next-line no-loop-func
      const message = messages.find((m) => m.messageId === currentMessageId);
      if (!message) {
        break;
      }
      orderedMessages.unshift(message);
      currentMessageId = message.parentMessageId;
    }

    if (orderedMessages.length === 0) {
      return [];
    }

    return orderedMessages.map((msg) => ({
      isCreatedByUser: msg.isCreatedByUser,
      content: msg.text
    }));
  }
}

module.exports = LlamaClient;
