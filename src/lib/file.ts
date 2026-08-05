/** Reads a File as a base64 data URI string (e.g. for sending to a backend
 * endpoint that expects `design_image_base64`). Browser-only (FileReader). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}
