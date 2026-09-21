export type TypeformForm = { id: string; title: string; updatedAt?: string; url?: string };
export type TypeformForms = {
  items: TypeformForm[];
  page: number;
  pageCount: number;
  total: number;
};
export type TypeformResponse = {
  id: string;
  submittedAt: string;
  answers: { question: string; value: string }[];
};
export type TypeformResponses = {
  form: TypeformForm;
  items: TypeformResponse[];
  total: number;
  nextBefore: string | null;
  note: string;
};
export type TypeformGrant = { userId: string; email: string; formId: string; title: string };
export type TypeformStatus = {
  connected: boolean;
  owner: boolean;
  updatedAt?: string;
  grants?: TypeformGrant[];
};
