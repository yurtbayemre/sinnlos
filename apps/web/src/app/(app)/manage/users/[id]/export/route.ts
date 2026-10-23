import { exportDownload } from "@/lib/manage/user-downloads";

/** The data-subject export of one user as a JSON download (v0.28, admin_role; lib/manage/user-downloads.ts). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return exportDownload((await params).id);
}
