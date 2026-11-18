// Fetching the week's workbook in the browser and saving it, so an error from
// /api/ugeplan is shown to the user instead of being saved as the file.

const FALLBACK_FILE_NAME = "ugeplan.xlsx";

/** The file name of a Content-Disposition header: filename* first, then filename. */
export function fileNameFrom(header: string | null): string {
  if (!header) return FALLBACK_FILE_NAME;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // A broken encoding: try the plain filename.
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(header);
  const name = (plain?.[1] ?? plain?.[2])?.trim();
  return name || FALLBACK_FILE_NAME;
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before the URL goes.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Fetches the workbook and saves it. Returns the file name; throws an Error
 * with the portal's Danish message when the answer is not a file.
 */
export async function fetchWorkbook(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).trim();
    throw new Error(text || `Portalen svarede med fejl ${res.status}.`);
  }
  const name = fileNameFrom(res.headers.get("content-disposition"));
  saveBlob(await res.blob(), name);
  return name;
}
