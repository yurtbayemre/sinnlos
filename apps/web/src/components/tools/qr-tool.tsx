"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Download, QrCode } from "lucide-react";
import { useCleanDocument } from "@/components/secrets/clean-document";
import { Button } from "@/components/ui/button";
import { downloadBlob } from "@/lib/browser-download";
import {
  isTooMuchData,
  pngBlob,
  textPayload,
  vcardPayload,
  wifiPayload,
  type QrIssue,
  type WifiSecurity,
} from "@/lib/qr-code";

type Kind = "text" | "wifi" | "contact";
const KINDS: readonly Kind[] = ["text", "wifi", "contact"];
const SECURITIES: readonly WifiSecurity[] = ["WPA", "WEP", "nopass"];
/** Pixels of the PNG and the SVG's width. */
const SIZES = { small: 256, medium: 512, large: 1024 } as const;
type Size = keyof typeof SIZES;

const EMPTY = {
  text: "",
  ssid: "",
  password: "",
  security: "WPA" as WifiSecurity,
  givenName: "",
  familyName: "",
  phone: "",
  email: "",
};

const INPUT =
  "h-10 w-full rounded-xl border bg-muted/40 px-3 text-sm outline-hidden focus:bg-background focus:ring-2 focus:ring-ring";

/**
 * /tools/qr (v1.1): a QR code for a link or text, a Wi-Fi login or a contact card, made in
 * the browser with `qrcode` (error correction M), downloaded as PNG or SVG. Nothing is
 * sent or stored; the fields have no `name`, so even a native form submit would carry none
 * of them, and they stay locked until the document is known to be free of analytics
 * (useCleanDocument, as on the secrets pages). The picture's alt text names the kind of
 * content, never the content (a Wi-Fi password). Refusals and "too much data" come through
 * a live region; a change of any field drops the picture it no longer matches.
 */
export function QrTool() {
  const t = useTranslations("tools.qr");
  const clean = useCleanDocument();
  const ids = useId();
  const [kind, setKind] = useState<Kind>("text");
  const [fields, setFields] = useState(EMPTY);
  const [size, setSize] = useState<Size>("medium");
  const [made, setMade] = useState<{ kind: Kind; png: string; svg: string } | null>(null);
  const [issue, setIssue] = useState<QrIssue | "failed" | null>(null);

  const edit = (change: Partial<typeof EMPTY>) => {
    setFields((current) => ({ ...current, ...change }));
    setMade(null);
    setIssue(null);
  };

  const generate = async (event: React.FormEvent) => {
    event.preventDefault();
    setMade(null);
    setIssue(null);
    const built =
      kind === "text"
        ? textPayload(fields.text)
        : kind === "wifi"
          ? wifiPayload(fields)
          : vcardPayload(fields);
    if (!built.ok) {
      setIssue(built.issue);
      return;
    }
    try {
      // The library loads here, so no other page carries it.
      const { default: QRCode } = await import("qrcode");
      const options = { errorCorrectionLevel: "M", width: SIZES[size] } as const;
      const [png, svg] = await Promise.all([
        QRCode.toDataURL(built.payload, options),
        QRCode.toString(built.payload, { ...options, type: "svg" }),
      ]);
      setMade({ kind, png, svg });
    } catch (error) {
      setIssue(isTooMuchData(error) ? "tooMuchData" : "failed");
    }
  };

  const field = (name: string, label: string, input: React.ReactNode) => (
    <div>
      <label htmlFor={`${ids}-${name}`} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {input}
    </div>
  );

  return (
    <form onSubmit={(event) => void generate(event)} noValidate className="max-w-2xl space-y-6">
      <div className="space-y-2 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">{t("privacy")}</p>
        <p>{t("notice")}</p>
      </div>

      <fieldset disabled={!clean} className="min-w-0 space-y-6">
        <fieldset>
          <legend className="mb-1 block text-sm font-medium">{t("kind")}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {KINDS.map((value) => (
              <label key={value} className="inline-flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${ids}-kind`}
                  checked={kind === value}
                  onChange={() => {
                    setKind(value);
                    setMade(null);
                    setIssue(null);
                  }}
                />
                {t(`kinds.${value}`)}
              </label>
            ))}
          </div>
        </fieldset>

        {kind === "text" &&
          field(
            "text",
            t("text"),
            <>
              <textarea
                id={`${ids}-text`}
                value={fields.text}
                onChange={(event) => edit({ text: event.target.value })}
                rows={4}
                autoComplete="off"
                spellCheck={false}
                aria-describedby={`${ids}-text-hint`}
                className="w-full rounded-xl border bg-muted/40 px-3 py-2 text-sm outline-hidden focus:bg-background focus:ring-2 focus:ring-ring"
              />
              <p id={`${ids}-text-hint`} className="mt-1 text-xs text-muted-foreground">
                {t("textHint")}
              </p>
            </>,
          )}

        {kind === "wifi" && (
          <>
            {field(
              "ssid",
              t("ssid"),
              <input
                id={`${ids}-ssid`}
                type="text"
                value={fields.ssid}
                onChange={(event) => edit({ ssid: event.target.value })}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className={INPUT}
              />,
            )}
            {field(
              "security",
              t("security"),
              <select
                id={`${ids}-security`}
                value={fields.security}
                onChange={(event) => edit({ security: event.target.value as WifiSecurity })}
                className={INPUT}
              >
                {SECURITIES.map((value) => (
                  <option key={value} value={value}>
                    {t(`securities.${value}`)}
                  </option>
                ))}
              </select>,
            )}
            {fields.security !== "nopass" &&
              field(
                "password",
                t("password"),
                // Shown as typed: the code on this page shows it to anyone who scans it anyway.
                <input
                  id={`${ids}-password`}
                  type="text"
                  value={fields.password}
                  onChange={(event) => edit({ password: event.target.value })}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  className={INPUT}
                />,
              )}
          </>
        )}

        {kind === "contact" && (
          <>
            <p className="text-xs text-muted-foreground">{t("contactHint")}</p>
            {field(
              "givenName",
              t("givenName"),
              <input
                id={`${ids}-givenName`}
                type="text"
                value={fields.givenName}
                onChange={(event) => edit({ givenName: event.target.value })}
                autoComplete="off"
                className={INPUT}
              />,
            )}
            {field(
              "familyName",
              t("familyName"),
              <input
                id={`${ids}-familyName`}
                type="text"
                value={fields.familyName}
                onChange={(event) => edit({ familyName: event.target.value })}
                autoComplete="off"
                className={INPUT}
              />,
            )}
            {field(
              "phone",
              t("phone"),
              <input
                id={`${ids}-phone`}
                type="tel"
                value={fields.phone}
                onChange={(event) => edit({ phone: event.target.value })}
                autoComplete="off"
                className={INPUT}
              />,
            )}
            {field(
              "email",
              t("email"),
              <input
                id={`${ids}-email`}
                type="email"
                value={fields.email}
                onChange={(event) => edit({ email: event.target.value })}
                autoComplete="off"
                className={INPUT}
              />,
            )}
          </>
        )}

        {field(
          "size",
          t("size"),
          <select
            id={`${ids}-size`}
            value={size}
            onChange={(event) => {
              setSize(event.target.value as Size);
              setMade(null);
            }}
            className={INPUT}
          >
            {(Object.keys(SIZES) as Size[]).map((value) => (
              <option key={value} value={value}>
                {t(`sizes.${value}`)}
              </option>
            ))}
          </select>,
        )}
      </fieldset>

      <Button type="submit" disabled={!clean}>
        <QrCode className="h-4 w-4" aria-hidden="true" />
        {t("generate")}
      </Button>

      {/* Live regions: the refusal, and the news that a code is there. */}
      <p role="status" className="sr-only">
        {made ? t("generated") : ""}
      </p>
      {issue ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${issue}`)}
        </p>
      ) : null}

      {made ? (
        <div className="space-y-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- an inline data URL, nothing to optimise */}
          <img
            src={made.png}
            alt={t(`alt.${made.kind}`)}
            className="h-64 w-64 max-w-full rounded-xl border bg-white"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => downloadBlob(pngBlob(made.png), "qr-code.png")}
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              {t("downloadPng")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                downloadBlob(new Blob([made.svg], { type: "image/svg+xml" }), "qr-code.svg")
              }
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              {t("downloadSvg")}
            </Button>
          </div>
        </div>
      ) : null}
    </form>
  );
}
