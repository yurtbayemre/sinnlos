import { evidenceDownload } from "@/lib/manage/user-downloads";

/** One user's training evidence as a CSV download (v0.28, admin_role; lib/manage/user-downloads.ts). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return evidenceDownload((await params).id);
}
