type Provider = 'openai' | 'anthropic';

const CUSTOM_VALUE = '__custom__';
const MODELS_BY_PROVIDER: Record<Provider, readonly string[]> = {
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'],
  anthropic: [
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'claude-3-5-sonnet-latest',
    'claude-3-5-haiku-latest',
    'claude-3-haiku-20240307',
  ],
};
const DEFAULT_MODEL_BY_PROVIDER: Record<Provider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-5',
};

const providerSelect = document.getElementById('provider-select') as HTMLSelectElement;
const apiKeyEl = document.getElementById('api-key') as HTMLInputElement;
const apiKeyHelp = document.getElementById('api-key-help') as HTMLParagraphElement;
const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
const modelHint = document.getElementById('model-hint') as HTMLParagraphElement;
const modelCustomWrap = document.getElementById('model-custom-wrap') as HTMLDivElement;
const modelCustom = document.getElementById('model-custom') as HTMLInputElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const statusEl = document.getElementById('status')!;

function currentProvider(): Provider {
  return providerSelect.value === 'anthropic' ? 'anthropic' : 'openai';
}

function providerApiKeyHelp(provider: Provider): string {
  return provider === 'anthropic'
    ? 'Get an Anthropic API key at https://console.anthropic.com/settings/keys'
    : 'Get an OpenAI API key at https://platform.openai.com/api-keys';
}

function providerModelHint(provider: Provider): string {
  return provider === 'anthropic'
    ? 'Includes Claude Sonnet 4.5 / 4.6 presets. If your account uses a different exact ID, choose Custom model ID.'
    : 'Use OpenAI API model IDs. You can choose Custom model ID if needed.';
}

function rebuildModelOptions(provider: Provider): void {
  const preset = MODELS_BY_PROVIDER[provider];
  modelSelect.innerHTML = '';
  for (const m of preset) {
    const option = document.createElement('option');
    option.value = m;
    if (provider === 'anthropic') {
      if (m === 'claude-sonnet-4-6') option.textContent = 'Claude Sonnet 4.6';
      else if (m === 'claude-sonnet-4-5') option.textContent = 'Claude Sonnet 4.5';
      else if (m === 'claude-3-5-sonnet-latest') option.textContent = 'Claude 3.5 Sonnet (lower cost)';
      else if (m === 'claude-3-5-haiku-latest') option.textContent = 'Claude 3.5 Haiku (low cost)';
      else if (m === 'claude-3-haiku-20240307') option.textContent = 'Claude 3 Haiku (lowest cost)';
      else option.textContent = m;
    } else {
      option.textContent = m;
    }
    modelSelect.appendChild(option);
  }
  const custom = document.createElement('option');
  custom.value = CUSTOM_VALUE;
  custom.textContent = 'Custom model ID…';
  modelSelect.appendChild(custom);
}

function isPreset(provider: Provider, model: string): boolean {
  return MODELS_BY_PROVIDER[provider].includes(model);
}

function applyModelToUi(provider: Provider, saved: string) {
  if (isPreset(provider, saved)) {
    modelSelect.value = saved;
    modelCustomWrap.hidden = true;
    modelCustom.value = '';
    return;
  }
  modelSelect.value = CUSTOM_VALUE;
  modelCustomWrap.hidden = false;
  modelCustom.value = saved;
}

function getModelToSave(): string {
  const provider = currentProvider();
  if (modelSelect.value === CUSTOM_VALUE) {
    const v = modelCustom.value.trim();
    return v || DEFAULT_MODEL_BY_PROVIDER[provider];
  }
  return modelSelect.value || DEFAULT_MODEL_BY_PROVIDER[provider];
}

function getApiKeyStorageKey(provider: Provider): string {
  return provider === 'anthropic' ? 'anthropicApiKey' : 'openaiApiKey';
}

function syncProviderUi(provider: Provider): void {
  apiKeyHelp.innerHTML = providerApiKeyHelp(provider).replace(
    /(https?:\/\/\S+)/g,
    '<a href="$1" target="_blank" rel="noreferrer">$1</a>'
  );
  modelHint.textContent = providerModelHint(provider);
}

async function load() {
  const data = await chrome.storage.local.get([
    'aiProvider',
    'openaiApiKey',
    'anthropicApiKey',
    'openaiModel',
    'anthropicModel',
  ]);
  const provider =
    data.aiProvider === 'anthropic' ? 'anthropic' : 'openai';
  providerSelect.value = provider;
  syncProviderUi(provider);
  rebuildModelOptions(provider);
  const keyStorage = getApiKeyStorageKey(provider);
  apiKeyEl.value = typeof data[keyStorage] === 'string' ? data[keyStorage] : '';
  const modelStorage = provider === 'anthropic' ? 'anthropicModel' : 'openaiModel';
  const saved =
    typeof data[modelStorage] === 'string' && data[modelStorage]
      ? data[modelStorage]
      : DEFAULT_MODEL_BY_PROVIDER[provider];
  applyModelToUi(provider, saved);
}

modelSelect.addEventListener('change', () => {
  const custom = modelSelect.value === CUSTOM_VALUE;
  modelCustomWrap.hidden = !custom;
  if (!custom) {
    modelCustom.value = '';
  } else {
    modelCustom.focus();
  }
});

providerSelect.addEventListener('change', async () => {
  const provider = currentProvider();
  syncProviderUi(provider);
  rebuildModelOptions(provider);
  const data = await chrome.storage.local.get([
    'openaiApiKey',
    'anthropicApiKey',
    'openaiModel',
    'anthropicModel',
  ]);
  apiKeyEl.value =
    typeof data[getApiKeyStorageKey(provider)] === 'string'
      ? data[getApiKeyStorageKey(provider)]
      : '';
  const modelStorage = provider === 'anthropic' ? 'anthropicModel' : 'openaiModel';
  const saved =
    typeof data[modelStorage] === 'string' && data[modelStorage]
      ? data[modelStorage]
      : DEFAULT_MODEL_BY_PROVIDER[provider];
  applyModelToUi(provider, saved);
});

saveBtn.addEventListener('click', async () => {
  const provider = currentProvider();
  const keyStorage = getApiKeyStorageKey(provider);
  const modelStorage = provider === 'anthropic' ? 'anthropicModel' : 'openaiModel';
  statusEl.textContent = 'Saved.';
  await chrome.storage.local.set({
    aiProvider: provider,
    [keyStorage]: apiKeyEl.value.trim(),
    [modelStorage]: getModelToSave(),
  });
});

void load();
