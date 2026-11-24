// Server-only: HAI's built-in image maker (Lovable AI Gateway). Needs no user API key.
import {
  GatewayError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  RequestRejectedError,
  editImage,
  generateImage,
} from "@lovable.dev/ai-gateway";

const IMAGE_MODEL = "openai/gpt-image-2.5-sunburst" as const;
export const IMAGE_MAKER_LABEL = "HAI image maker";
export const IMAGE_MODEL_NAME = "gpt-image-2.5";

export type HaiImageResult =
  | {
      ok: true;
      dataUrl: string;
      provider: string;
      model: string;
      /** Why HAI used a different image model than the first choice, when it did. */
      fallbackReason?: string;
    }
  | { ok: false; message: string };

function dataUrlToFile(dataUrl: string, index: number): File {
  const [head = "", base64 = ""] = dataUrl.split(",", 2);
  const mime = /^data:([^;]+);base64$/.exec(head)?.[1] ?? "image/png";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const ext = mime.split("/")[1] ?? "png";
  return new File([bytes], `input-${index + 1}.${ext}`, { type: mime });
}

/** Creates a picture from a description, or edits the attached pictures when any are given. */
export async function generateHaiImage(prompt: string, images: string[]): Promise<HaiImageResult> {
  const options = {
    prompt,
    size: "1024x1024",
    quality: "medium",
    output_format: "jpeg",
    output_compression: 88,
  } as const;
  try {
    const response = images.length
      ? await editImage({ model: IMAGE_MODEL, image: images.map(dataUrlToFile), ...options })
      : await generateImage({ model: IMAGE_MODEL, n: 1, ...options });
    const image = response.data?.[0];
    if (image?.b64_json) {
      return { ok: true, dataUrl: `data:image/jpeg;base64,${image.b64_json}`, provider: IMAGE_MAKER_LABEL, model: IMAGE_MODEL_NAME };
    }
    if (image?.url) return { ok: true, dataUrl: image.url, provider: IMAGE_MAKER_LABEL, model: IMAGE_MODEL_NAME };
    return { ok: false, message: "The image maker didn't return a picture. Try describing it differently." };
  } catch (error) {
    if (error instanceof PaymentRequiredError) {
      return { ok: false, message: "The built-in image maker is out of credits right now. Please try again later." };
    }
    if (error instanceof RateLimitError) {
      return { ok: false, message: "The image maker is busy. Wait a moment and try again." };
    }
    if (error instanceof RequestRejectedError || error instanceof PermissionDeniedError) {
      return { ok: false, message: "The image maker refused this request. Try a different description." };
    }
    if (error instanceof GatewayError) {
      console.error("image generation failed", error.code, error.ids);
      return { ok: false, message: "The image maker couldn't finish this picture. Please try again." };
    }
    console.error("image generation crashed", error instanceof Error ? error.message : error);
    return { ok: false, message: "The image maker couldn't finish this picture. Please try again." };
  }
}
