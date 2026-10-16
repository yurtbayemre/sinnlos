/** Registered before the core :id route so /authoring is not treated as an id. */
const UID = "api::lesson.lesson";

export default {
  routes: [
    {
      method: "GET",
      path: "/lessons/authoring",
      handler: "api::lesson.lesson.authoringList",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "authoringList" } }],
      },
    },
    {
      method: "GET",
      path: "/lessons/:id/editable",
      handler: "api::lesson.lesson.editable",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "editable" } }],
      },
    },
    {
      method: "POST",
      path: "/lessons/:id/publish",
      handler: "api::lesson.lesson.publish",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "publish" } }],
      },
    },
    {
      method: "POST",
      path: "/lessons/:id/unpublish",
      handler: "api::lesson.lesson.unpublish",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "unpublish" } }],
      },
    },
    {
      method: "POST",
      path: "/lessons/:id/discard-draft",
      handler: "api::lesson.lesson.discardDraft",
      config: {
        policies: [{ name: "global::can-author", config: { uid: UID, intent: "discardDraft" } }],
      },
    },
  ],
};
