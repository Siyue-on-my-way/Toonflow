import crypto from "node:crypto";

const ALGORITHM = "aes-256-cbc";
// In a real production app, this should be an environment variable.
// For this refactoring, we use a fixed key or derive it from a known secret.
const ENCRYPTION_KEY = crypto.scryptSync(process.env.APP_SECRET || "toonflow-secret-key", "salt", 32);
const IV_LENGTH = 16;

export function encrypt(text: string): string {
  if (!text) return text;
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    return iv.toString("hex") + ":" + encrypted;
  } catch (e) {
    console.error("Encryption error:", e);
    return text;
  }
}

export function decrypt(text: string): string {
  if (!text || !text.includes(":")) return text;
  try {
    const textParts = text.split(":");
    const iv = Buffer.from(textParts.shift()!, "hex");
    const encryptedText = Buffer.from(textParts.join(":"), "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedText, undefined, "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (e) {
    console.error("Decryption error:", e);
    return text; // Fallback to original text if decryption fails (e.g., for old unencrypted data)
  }
}
