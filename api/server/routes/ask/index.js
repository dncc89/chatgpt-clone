const express = require('express');
const router = express.Router();
// const askAzureOpenAI = require('./askAzureOpenAI';)
const askOpenAI = require('./askOpenAI');
const askGoogle = require('./askGoogle');
const askBingAI = require('./askBingAI');
const askChatGPTBrowser = require('./askChatGPTBrowser');
const askLlama = require('./askLlama');

// router.use('/azureOpenAI', askAzureOpenAI);
router.use('/openAI', askOpenAI);
router.use('/google', askGoogle);
router.use('/bingAI', askBingAI);
router.use('/chatGPTBrowser', askChatGPTBrowser);
router.use('/llama', askLlama);

module.exports = router;
