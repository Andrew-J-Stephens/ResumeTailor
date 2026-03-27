export type StoredResume = {
  id: string;
  fileName: string;
  mimeType: string;
  uploadedAt: number;
};

export type TailorRequest = {
  jobDescription: string;
};

export type CoverLetterRequest = {
  jobDescription: string;
};

export type TailorResult =
  | { ok: true; fileName: string }
  | { ok: false; error: string };
