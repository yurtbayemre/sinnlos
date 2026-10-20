import type { Document } from "@/lib/types";
import type { DemoClock } from "./clock";
import type { DemoUsers } from "./people";

export function demoDocuments(users: DemoUsers, clock: DemoClock) {
  const documents = [
    {
      id: 1,
      documentId: "demodoc00000000000000001",
      title: "Travel & expense policy",
      description: "Per-diems, booking rules and how to file expenses.",
      category: "policy",
      requiresAck: true,
      file: {
        url: "/uploads/demo-travel-policy.pdf",
        name: "travel-policy.pdf",
        size: 412,
        mime: "application/pdf",
      },
      departments: [],
      uploadedBy: users.maria,
      createdAt: clock.iso(-30),
      updatedAt: clock.iso(-3),
    },
    {
      id: 2,
      documentId: "demodoc00000000000000002",
      title: "Equipment request form",
      description: "Laptops, monitors, chairs — one form for everything.",
      category: "form",
      file: {
        url: "/uploads/demo-equipment-form.pdf",
        name: "equipment-form.pdf",
        size: 96,
        mime: "application/pdf",
      },
      departments: [{ id: 2, name: "People & Culture", slug: "people-culture" }],
      uploadedBy: users.jonas,
      createdAt: clock.iso(-20),
      updatedAt: clock.iso(-20),
    },
    {
      id: 3,
      documentId: "demodoc00000000000000003",
      title: "Brand guidelines v3",
      description: "Logo usage, color palette and tone of voice.",
      category: "guide",
      file: {
        url: "/uploads/demo-brand-guidelines.pdf",
        name: "brand-guidelines.pdf",
        size: 2380,
        mime: "application/pdf",
      },
      departments: [{ id: 3, name: "Marketing", slug: "marketing" }],
      uploadedBy: users.sofia,
      createdAt: clock.iso(-12),
      updatedAt: clock.iso(-5),
    },
  ] satisfies Document[];

  return { documents };
}
