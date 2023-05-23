const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const addToCache = require('./addToCache');
const { getLlamaModels } = require('../endpoints');
const { titleConvo, askLlama } = require('../../../app/');
const { saveMessage, getConvoTitle, saveConvo, getConvo } = require('../../../models');
const { handleError, sendMessage, createOnProgress, handleText } = require('./handlers');
const requireJwtAuth = require('../../../middleware/requireJwtAuth');
const LlamaClient = require('../../../app/clients/llama-client');

const abortControllers = new Map();

router.post('/abort', requireJwtAuth, async (req, res) => {
  const { abortKey } = req.body;
  console.log(`req.body`, req.body);
  if (!abortControllers.has(abortKey)) {
    return res.status(404).send('Request not found');
  }

  const { abortController } = abortControllers.get(abortKey);

  abortControllers.delete(abortKey);
  const ret = await abortController.abortAsk();
  console.log('Aborted request', abortKey);
  console.log('Aborted message:', ret);

  res.send(JSON.stringify(ret));
});

router.post('/', requireJwtAuth, async (req, res) => {
  const {
    endpoint,
    text,
    overrideParentMessageId = null,
    parentMessageId,
    conversationId: oldConversationId
  } = req.body;
  if (text.length === 0) return handleError(res, { text: 'Prompt empty or too short' });
  if (endpoint !== 'llama') return handleError(res, { text: 'Illegal request' });

  // build user message
  const conversationId = oldConversationId || crypto.randomUUID();
  const isNewConversation = !oldConversationId;
  const userMessageId = crypto.randomUUID();
  const userParentMessageId = parentMessageId || '00000000-0000-0000-0000-000000000000';
  const userMessage = {
    messageId: userMessageId,
    sender: 'User',
    text,
    parentMessageId: userParentMessageId,
    conversationId,
    isCreatedByUser: true
  };

  // build endpoint option
  const endpointOption = {
    model: req.body?.model ?? 'gpt-3.5-turbo',
    chatGptLabel: req.body?.chatGptLabel ?? null,
    promptPrefix: req.body?.promptPrefix ?? null,
    temperature: req.body?.temperature ?? 1,
    top_p: req.body?.top_p ?? 1,
    presence_penalty: req.body?.presence_penalty ?? 0,
    frequency_penalty: req.body?.frequency_penalty ?? 0
  };

  const availableModels = getLlamaModels();
  // if (availableModels.find((model) => model === endpointOption.model) === undefined)
  // return handleError(res, { text: 'Illegal request: model' });

  console.log('ask log', {
    userMessage,
    endpointOption,
    conversationId
  });

  await saveMessage(userMessage);
  await saveConvo(req.user.id, {
    ...userMessage,
    ...endpointOption,
    conversationId,
    endpoint
  });

  // eslint-disable-next-line no-use-before-define
  return await ask({
    isNewConversation,
    userMessage,
    endpointOption,
    conversationId,
    preSendRequest: true,
    req,
    res
  });
});

const ask = async ({
  isNewConversation,
  userMessage,
  endpointOption,
  conversationId,
  preSendRequest = true,
  req,
  res
}) => {
  let { text, parentMessageId: userParentMessageId, messageId: userMessageId } = userMessage;
  const userId = req.user.id;
  let responseMessageId = crypto.randomUUID();

  res.writeHead(200, {
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no'
  });

  if (preSendRequest) sendMessage(res, { message: userMessage, created: true });

  try {
    const getIds = (data) => {
      userMessage = data.userMessage;
      userMessageId = userMessage.messageId;
      responseMessageId = data.responseMessageId;
      if (!conversationId) {
        conversationId = data.conversationId;
      }
    };

    let lastSavedTimestamp = 0;
    const { onProgress: progressCallback, getPartialText } = createOnProgress({
      onProgress: ({ text }) => {
        const currentTimestamp = Date.now();
        if (currentTimestamp - lastSavedTimestamp > 500) {
          lastSavedTimestamp = currentTimestamp;
          saveMessage({
            messageId: responseMessageId,
            sender: endpointOption?.chatGptLabel || 'ChatGPT',
            conversationId,
            parentMessageId: userMessageId,
            text: text,
            unfinished: true,
            cancelled: false,
            error: false
          });
        }
      }
    });

    let abortController = new AbortController();
    abortController.abortAsk = async function () {
      this.abort();

      const responseMessage = {
        messageId: responseMessageId,
        sender: endpointOption?.chatGptLabel || 'ChatGPT',
        conversationId,
        parentMessageId: userMessageId,
        text: getPartialText(),
        unfinished: false,
        cancelled: true,
        error: false
      };

      saveMessage(responseMessage);
      await addToCache({ endpoint: 'openAI', endpointOption, userMessage, responseMessage });

      return {
        title: await getConvoTitle(req.user.id, conversationId),
        final: true,
        conversation: await getConvo(req.user.id, conversationId),
        requestMessage: userMessage,
        responseMessage: responseMessage
      };
    };
    const abortKey = conversationId;
    abortControllers.set(abortKey, { abortController, ...endpointOption });
    const oaiApiKey = req.body?.token ?? null;
    const client = new LlamaClient({ oaiApiKey });

    // let response = await askLlama({
    //   text,
    //   parentMessageId: userParentMessageId,
    //   conversationId,
    //   oaiApiKey,
    //   ...endpointOption,
    //   onProgress: progressCallback.call(null, {
    //     res,
    //     text,
    //     parentMessageId: overrideParentMessageId || userMessageId
    //   }),
    //   abortController,
    //   userId
    // });

    let response = await client.sendMessage(text, {
      getIds,
      user: req.user.id,
      parentMessageId: userParentMessageId,
      conversationId,
      onProgress: progressCallback.call(null, { res, text, parentMessageId: userMessageId }),
      abortController
    });

    abortControllers.delete(abortKey);
    console.log('CLIENT RESPONSE', response);

    // If response has parentMessageId, the fake userMessage.messageId should be updated to the real one.
    await saveMessage(response);
    sendMessage(res, {
      title: await getConvoTitle(req.user.id, conversationId),
      final: true,
      conversation: await getConvo(req.user.id, conversationId),
      requestMessage: userMessage,
      responseMessage: response
    });
    res.end();

    if (userParentMessageId == '00000000-0000-0000-0000-000000000000') {
      const title = await titleConvo({
        endpoint: 'openAI',
        text,
        response: response
      });
      await saveConvo(req.user.id, {
        conversationId: conversationId,
        title
      });
    }
  } catch (error) {
    console.error(error);
    const errorMessage = {
      messageId: responseMessageId,
      sender: 'LLaMa',
      conversationId,
      parentMessageId,
      unfinished: false,
      cancelled: false,
      error: true,
      text: error.message
    };
    await saveMessage(errorMessage);
    handleError(res, errorMessage);
  }
};

module.exports = router;
