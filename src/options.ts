type Provider = 'openai' | 'anthropic';

const CUSTOM_VALUE = '__custom__';
const MODELS_BY_PROVIDER: Record<Provider, readonly string[]> = {
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'],
  /**
   * IDs from Anthropic Claude API (aliases and dated snapshots).
   * @see https://docs.anthropic.com/en/docs/about-claude/models
   */
  anthropic: [
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    'claude-sonnet-4-5',
    'claude-opus-4-5',
    'claude-sonnet-4-0',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022',
  ],
};
const DEFAULT_MODEL_BY_PROVIDER: Record<Provider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-5',
};

/** Retired or informal IDs → current API strings so saved settings keep working. */
const ANTHROPIC_LEGACY_MODEL_IDS: Record<string, string> = {
  'claude-3-5-sonnet-latest': 'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-latest': 'claude-3-5-haiku-20241022',
  'claude-sonnet-4': 'claude-sonnet-4-0',
  'claude-opus-4': 'claude-opus-4-0',
};

const ANTHROPIC_PRESET_LABELS: Record<string, string> = {
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-haiku-4-5': 'Claude Haiku 4.5 (fast, lower cost)',
  'claude-sonnet-4-5': 'Claude Sonnet 4.5',
  'claude-opus-4-5': 'Claude Opus 4.5',
  'claude-sonnet-4-0': 'Claude Sonnet 4',
  'claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet (snapshot 20241022)',
  'claude-3-5-haiku-20241022': 'Claude 3.5 Haiku (snapshot 20241022)',
};

function normalizeAnthropicModelId(id: string): string {
  return ANTHROPIC_LEGACY_MODEL_IDS[id] ?? id;
}

const providerSelect = document.getElementById('provider-select') as HTMLSelectElement;
const apiKeyEl = document.getElementById('api-key') as HTMLInputElement;
const apiKeyHelp = document.getElementById('api-key-help') as HTMLParagraphElement;
const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
const modelHint = document.getElementById('model-hint') as HTMLParagraphElement;
const modelCustomWrap = document.getElementById('model-custom-wrap') as HTMLDivElement;
const modelCustom = document.getElementById('model-custom') as HTMLInputElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const openTemplateBuilder = document.getElementById('open-template-builder') as HTMLAnchorElement;
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
    ? 'Preset IDs match Anthropic Claude API (aliases such as claude-haiku-4-5 and dated snapshots). See docs.anthropic.com models page. Use Custom for Bedrock/Vertex-only IDs.'
    : 'Includes GPT presets. You can choose Custom model ID if needed.';
}

function rebuildModelOptions(provider: Provider): void {
  const preset = MODELS_BY_PROVIDER[provider];
  modelSelect.innerHTML = '';
  for (const m of preset) {
    const option = document.createElement('option');
    option.value = m;
    if (provider === 'anthropic') {
      option.textContent = ANTHROPIC_PRESET_LABELS[m] ?? m;
    } else {
      if (m === 'gpt-4o-mini') option.textContent = 'GPT-4o mini (fast, lower cost)';
      else if (m === 'gpt-4o') option.textContent = 'GPT-4o';
      else if (m === 'gpt-4-turbo') option.textContent = 'GPT-4 Turbo';
      else if (m === 'gpt-4') option.textContent = 'GPT-4';
      else if (m === 'gpt-3.5-turbo') option.textContent = 'GPT-3.5 Turbo (lowest cost)';
      else option.textContent = m;
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
    const base = v || DEFAULT_MODEL_BY_PROVIDER[provider];
    return provider === 'anthropic' ? normalizeAnthropicModelId(base) : base;
  }
  const v = modelSelect.value || DEFAULT_MODEL_BY_PROVIDER[provider];
  return provider === 'anthropic' ? normalizeAnthropicModelId(v) : v;
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
  let saved =
    typeof data[modelStorage] === 'string' && data[modelStorage]
      ? data[modelStorage]
      : DEFAULT_MODEL_BY_PROVIDER[provider];
  if (provider === 'anthropic') saved = normalizeAnthropicModelId(saved);
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
  let saved =
    typeof data[modelStorage] === 'string' && data[modelStorage]
      ? data[modelStorage]
      : DEFAULT_MODEL_BY_PROVIDER[provider];
  if (provider === 'anthropic') saved = normalizeAnthropicModelId(saved);
  applyModelToUi(provider, saved);
});

openTemplateBuilder.addEventListener('click', (ev) => {
  ev.preventDefault();
  void chrome.tabs.create({ url: chrome.runtime.getURL('template-builder.html') });
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

export {};
