const PRESET_MODELS = [
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4-turbo',
  'gpt-4',
  'gpt-3.5-turbo',
] as const;

const CUSTOM_VALUE = '__custom__';
const DEFAULT_MODEL = 'gpt-4o-mini';

const apiKeyEl = document.getElementById('api-key') as HTMLInputElement;
const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
const modelCustomWrap = document.getElementById('model-custom-wrap') as HTMLDivElement;
const modelCustom = document.getElementById('model-custom') as HTMLInputElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const statusEl = document.getElementById('status')!;

function isPreset(model: string): model is (typeof PRESET_MODELS)[number] {
  return (PRESET_MODELS as readonly string[]).includes(model);
}

function applyModelToUi(saved: string) {
  if (isPreset(saved)) {
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
  if (modelSelect.value === CUSTOM_VALUE) {
    const v = modelCustom.value.trim();
    return v || DEFAULT_MODEL;
  }
  return modelSelect.value || DEFAULT_MODEL;
}

async function load() {
  const { openaiApiKey, openaiModel } = await chrome.storage.local.get([
    'openaiApiKey',
    'openaiModel',
  ]);
  apiKeyEl.value = typeof openaiApiKey === 'string' ? openaiApiKey : '';
  const saved =
    typeof openaiModel === 'string' && openaiModel ? openaiModel : DEFAULT_MODEL;
  applyModelToUi(saved);
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

saveBtn.addEventListener('click', async () => {
  statusEl.textContent = 'Saved.';
  await chrome.storage.local.set({
    openaiApiKey: apiKeyEl.value.trim(),
    openaiModel: getModelToSave(),
  });
});

void load();
