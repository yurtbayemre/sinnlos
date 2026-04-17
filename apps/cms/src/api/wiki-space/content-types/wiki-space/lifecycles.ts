import { revalidate } from "../../../../utils/revalidate";

function tagsFor(event: any): string[] {
  const slug: string | undefined = event?.result?.slug;
  const tags = ["wiki-spaces"];
  if (slug) tags.push(`wiki-space:${slug}`);
  return tags;
}

export default {
  async afterCreate(event: any) {
    await revalidate(tagsFor(event));
  },
  async afterUpdate(event: any) {
    await revalidate(tagsFor(event));
  },
  async afterDelete(event: any) {
    await revalidate(tagsFor(event));
  },
};
