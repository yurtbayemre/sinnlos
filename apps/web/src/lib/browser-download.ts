/**
 * Hands a Blob to the browser as a file download (the PDF and QR tools, the process
 * viewer's .bpmn and .svg). The object URL lives for one click: it is revoked in a later
 * task, so nothing of a result outlives the download. Safari loses a download
 * whose URL is revoked in the same task, hence the timeout.
 */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
