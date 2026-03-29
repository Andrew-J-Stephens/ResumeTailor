export const RESUME_TEMPLATE_STORAGE_KEY = 'resumeTemplateHtml' as const;

export async function loadResumeTemplateHtml(bundledDefault: string): Promise<string> {
  const raw = (await chrome.storage.local.get(RESUME_TEMPLATE_STORAGE_KEY))[
    RESUME_TEMPLATE_STORAGE_KEY
  ];
  if (typeof raw === 'string' && raw.trim().length > 200) {
    return raw;
  }
  return bundledDefault;
}

export async function saveResumeTemplateHtml(html: string): Promise<void> {
  await chrome.storage.local.set({ [RESUME_TEMPLATE_STORAGE_KEY]: html });
}

export async function clearStoredResumeTemplate(): Promise<void> {
  await chrome.storage.local.remove(RESUME_TEMPLATE_STORAGE_KEY);
}
