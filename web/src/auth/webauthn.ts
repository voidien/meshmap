/** Browser side of passkeys: converts between the server's base64url JSON and the WebAuthn API's ArrayBuffers. */
import { api } from "../api";

export const passkeysSupported = (): boolean => typeof window !== "undefined" && window.isSecureContext && !!window.PublicKeyCredential && !!navigator.credentials;

const toBuf = (s: string): ArrayBuffer => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};

const toB64u = (buf: ArrayBuffer | ArrayBufferView): string => {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

interface DescriptorJson {
  id: string;
  type: string;
  transports?: AuthenticatorTransport[];
}

const descriptors = (list: DescriptorJson[] | undefined): PublicKeyCredentialDescriptor[] | undefined =>
  list?.map((d) => ({ ...d, id: toBuf(d.id) }) as PublicKeyCredentialDescriptor);

/** Friendly text for the ways a passkey prompt fails (cancelled, no authenticator, wrong site...). */
export function passkeyErrorMessage(e: unknown): string {
  const err = e as { name?: string; message?: string };
  switch (err?.name) {
    case "NotAllowedError":
      return "The passkey prompt was cancelled or timed out.";
    case "InvalidStateError":
      return "This device already has a passkey for this account.";
    case "NotSupportedError":
      return "This browser or device can't create that kind of passkey.";
    case "SecurityError":
      return "Passkeys don't work at this web address. Use the https:// address.";
    default:
      return err?.message ?? "Passkey failed.";
  }
}

/** Create a passkey on this device for the signed-in user. */
export async function registerPasskey(name: string): Promise<void> {
  const { challengeId, options } = await api.post<{ challengeId: string; options: { publicKey: Record<string, unknown> } }>("/api/passkeys/register/start", {});
  const pk = options.publicKey as {
    challenge: string;
    user: { id: string; name: string; displayName: string };
    excludeCredentials?: DescriptorJson[];
  } & Record<string, unknown>;
  const cred = (await navigator.credentials.create({
    publicKey: { ...pk, challenge: toBuf(pk.challenge), user: { ...pk.user, id: toBuf(pk.user.id) }, excludeCredentials: descriptors(pk.excludeCredentials) } as unknown as PublicKeyCredentialCreationOptions,
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was created.");
  const att = cred.response as AuthenticatorAttestationResponse;
  await api.post("/api/passkeys/register/finish", {
    challengeId,
    name,
    credential: {
      id: cred.id,
      rawId: toB64u(cred.rawId),
      type: cred.type,
      response: { attestationObject: toB64u(att.attestationObject), clientDataJSON: toB64u(att.clientDataJSON), transports: att.getTransports?.() },
      extensions: cred.getClientExtensionResults(),
    },
  });
}

/** Sign in with a passkey for `username`. The server sets the session cookie; returns its session info. */
export async function loginWithPasskey<T>(username: string): Promise<T> {
  const { challengeId, options } = await api.post<{ challengeId: string; options: { publicKey: Record<string, unknown> } }>("/api/passkeys/login/start", { username });
  const pk = options.publicKey as { challenge: string; allowCredentials?: DescriptorJson[] } & Record<string, unknown>;
  const cred = (await navigator.credentials.get({
    publicKey: { ...pk, challenge: toBuf(pk.challenge), allowCredentials: descriptors(pk.allowCredentials) } as unknown as PublicKeyCredentialRequestOptions,
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was used.");
  const r = cred.response as AuthenticatorAssertionResponse;
  return api.post<T>("/api/passkeys/login/finish", {
    challengeId,
    credential: {
      id: cred.id,
      rawId: toB64u(cred.rawId),
      type: cred.type,
      response: {
        authenticatorData: toB64u(r.authenticatorData),
        clientDataJSON: toB64u(r.clientDataJSON),
        signature: toB64u(r.signature),
        userHandle: r.userHandle ? toB64u(r.userHandle) : undefined,
      },
      extensions: cred.getClientExtensionResults(),
    },
  });
}

/** A short name for a new passkey based on the device, e.g. "Chrome on Windows". */
export function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "device";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${br} on ${os}`;
}
