import { revalidate } from "../../../../utils/revalidate";

export default {
  async afterCreate() {
    await revalidate(["announcements"]);
  },
  async afterUpdate() {
    await revalidate(["announcements"]);
  },
  async afterDelete() {
    await revalidate(["announcements"]);
  },
};
