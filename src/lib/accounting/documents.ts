export interface AccountingDocument {
  id: string;
  version: number;
  original_name: string;
  storage_path: string;
  content_hash: string;
  mime_type: string;
  size_bytes: string;
  state: "uploading" | "available" | "missing" | "archived";
  created_at: string;
  entries: { id: string; memo: string; entry_date: string }[];
}
export interface DocumentList {
  documents: AccountingDocument[];
  total: number;
}
