export type TailorRequest = {
  jobDescription: string;
};

export type CoverLetterRequest = {
  jobDescription: string;
};

export type TailorResult =
  | { ok: true; fileName: string }
  | { ok: false; error: string };
