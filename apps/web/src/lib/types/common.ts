/**
 * Shapes shared by every domain (WD01, split from lib/types.ts): a user as
 * a relation or a directory row, and an image upload's renditions. Fields
 * are optional-by-default because population varies per query; each
 * lib/api/*.ts read names the fields its populate actually delivers.
 */

/** An image upload with Strapi's generated renditions (avatars, covers). */
export interface MediaImage {
  url?: string;
  formats?: {
    thumbnail?: { url?: string };
    small?: { url?: string };
  } | null;
}

export interface UserLite {
  id: number;
  username?: string;
  email?: string;
  displayName?: string;
  jobTitle?: string;
  avatar?: MediaImage | null;
  phone?: string;
  officeLocation?: string;
  department?: { id: number; name: string; slug: string } | null;
  manager?: UserLite | null;
  directReports?: UserLite[];
  hireDate?: string;
}
