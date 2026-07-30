'use strict';

function resolveQueueModel(requested, allowedModels, defaultModel) {
  if (requested == null || requested === '') return defaultModel;
  if (typeof requested !== 'string') throw new Error('Queue field "model" must be a string.');
  const model = allowedModels.find(name => name.toLowerCase() === requested.trim().toLowerCase());
  if (!model) throw new Error(`Queue model "${requested}" is not in this worker's local allow-list.`);
  return model;
}

module.exports = { resolveQueueModel };
