/**
 * Custom (non-CRUD) classified routes. Access is granted per role via
 * CUSTOM_ACTION_GRANTS in src/index.ts (users-permissions gates every
 * route behind a permission row) — the five employee roles, never guest.
 * The action itself enforces ownership (provider_metadata.uploadedBy must
 * match the caller), so no policy is needed here.
 */
export default {
  routes: [
    {
      method: "POST",
      path: "/classifieds/cleanup-uploads",
      handler: "api::classified.classified.cleanupUploads",
      config: { policies: [] },
    },
  ],
};
