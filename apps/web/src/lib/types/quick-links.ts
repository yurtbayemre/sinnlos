/** Dashboard quick links (WD01; the type was implicit before). */

export interface QuickLink {
  id: number;
  documentId?: string;
  label?: string;
  url?: string;
  /** A lucide icon name, resolved through components/icon-map.ts. */
  icon?: string | null;
  category?: string | null;
  order?: number;
}
