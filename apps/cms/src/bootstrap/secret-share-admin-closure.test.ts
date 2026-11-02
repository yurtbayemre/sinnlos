import { describe, expect, it, vi } from "vitest";
import { errors } from "@strapi/utils";

import { closeSecretSharesInAdmin } from "./secret-share-admin-closure";

/**
 * The Content Manager refuses secret shares at its permission checker and
 * at the preview, whatever a role holds (v0.35.0, plan §3.6). Every route
 * family runs against the real panel after a deliberate re-grant in
 * integration/secret-shares-admin.integration.test.ts.
 */

const SHARE = "api::secret-share.secret-share";

function host() {
  const create = vi.fn((params: { model?: string }) => ({ checker: params.model }));
  const getPreviewUrl = vi.fn(async (uid: string) => `/preview/${uid}`);
  const services: Record<string, Record<string, unknown>> = {
    "permission-checker": { create },
    preview: { getPreviewUrl },
  };
  const strapi = {
    plugin: (name: string) =>
      name === "content-manager" ? { service: (service: string) => services[service] } : undefined,
  };
  return { strapi, services, create, getPreviewUrl };
}

describe("closeSecretSharesInAdmin", () => {
  it("refuses the secret-share uid at once and passes every other model through", async () => {
    const { strapi, services, create, getPreviewUrl } = host();
    closeSecretSharesInAdmin(strapi);
    const checker = services["permission-checker"].create as (p: { model: string }) => unknown;
    expect(() => checker({ model: SHARE })).toThrow(errors.ForbiddenError);
    expect(create).not.toHaveBeenCalled();
    expect(checker({ model: "api::kudos.kudos" })).toEqual({ checker: "api::kudos.kudos" });
    const preview = services.preview.getPreviewUrl as (uid: string, p: unknown) => unknown;
    expect(() => preview(SHARE, {})).toThrow(errors.ForbiddenError);
    expect(getPreviewUrl).not.toHaveBeenCalled();
    await expect(preview("api::event.event", {})).resolves.toBe("/preview/api::event.event");
  });

  it("refuses to boot when a service is gone", () => {
    expect(() => closeSecretSharesInAdmin({ plugin: () => undefined })).toThrow(/\[secrets\]/);
    const { strapi, services } = host();
    delete services.preview.getPreviewUrl;
    expect(() => closeSecretSharesInAdmin(strapi)).toThrow(/refusing to boot/);
  });
});
