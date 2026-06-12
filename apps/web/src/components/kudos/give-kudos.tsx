"use client";

import { useState, useTransition, useMemo } from "react";
import { useTranslations } from "next-intl";
import { Award, Send, X, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { sendKudos } from "@/lib/kudos-actions";
import type { UserLite, KudosValue } from "@/lib/types";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { initials } from "@/lib/utils";

const VALUES: { value: KudosValue; labelKey: "teamwork" | "innovation" | "leadership" | "customerFocus" | "excellence"; emoji: string }[] = [
  { value: "teamwork", labelKey: "teamwork", emoji: "\u{1F91D}" },
  { value: "innovation", labelKey: "innovation", emoji: "\u{1F4A1}" },
  { value: "leadership", labelKey: "leadership", emoji: "\u{1F31F}" },
  { value: "customer-focus", labelKey: "customerFocus", emoji: "\u{1F3AF}" },
  { value: "excellence", labelKey: "excellence", emoji: "\u{1F3C6}" },
];

export function GiveKudos({ people }: { people: UserLite[] }) {
  const t = useTranslations("kudos");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<UserLite | null>(null);
  const [message, setMessage] = useState("");
  const [value, setValue] = useState<KudosValue>("teamwork");
  const [isPending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    if (!search) return [];
    const q = search.toLowerCase();
    return people
      .filter((p) => {
        const hay = [p.displayName, p.email, p.jobTitle].filter(Boolean).join(" ").toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 5);
  }, [people, search]);

  const reset = () => {
    setSearch("");
    setSelected(null);
    setMessage("");
    setValue("teamwork");
    setOpen(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !message.trim()) return;
    startTransition(async () => {
      await sendKudos(selected.id, message.trim(), value);
      reset();
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
      >
        <Award className="h-4 w-4" />
        Give kudos
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-background/60 p-4 backdrop-blur-sm"
          onMouseDown={() => setOpen(false)}
        >
          <form
            onSubmit={handleSubmit}
            onMouseDown={(e) => e.stopPropagation()}
            className="w-full max-w-md animate-scale-in rounded-2xl border bg-background p-6 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Give kudos</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg p-1 transition hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-4">
              {/* Recipient picker */}
              <div>
                <label className="mb-1 block text-sm font-medium">To</label>
                {selected ? (
                  <div className="flex items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2">
                    <Avatar className="h-7 w-7">
                      <AvatarFallback className="text-xs">
                        {initials(selected.displayName)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="text-sm font-medium">
                      {selected.displayName ?? selected.email}
                    </span>
                    <button
                      type="button"
                      onClick={() => { setSelected(null); setSearch(""); }}
                      className="ml-auto text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="text"
                      placeholder="Search for a colleague..."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="h-10 w-full rounded-xl border bg-muted/40 pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring"
                    />
                    {filtered.length > 0 && (
                      <div className="absolute inset-x-0 top-full z-10 mt-1 max-h-40 overflow-y-auto rounded-xl border bg-background shadow-lg">
                        {filtered.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => { setSelected(p); setSearch(""); }}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition hover:bg-muted"
                          >
                            <Avatar className="h-7 w-7">
                              <AvatarFallback className="text-xs">
                                {initials(p.displayName)}
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              <div className="font-medium">{p.displayName ?? p.email}</div>
                              {p.jobTitle && (
                                <div className="text-xs text-muted-foreground">{p.jobTitle}</div>
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Value selector */}
              <div>
                <label className="mb-1 block text-sm font-medium">For</label>
                <div className="flex flex-wrap gap-2">
                  {VALUES.map((v) => (
                    <button
                      key={v.value}
                      type="button"
                      onClick={() => setValue(v.value)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition",
                        value === v.value
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "hover:border-border hover:bg-muted",
                      )}
                    >
                      <span>{v.emoji}</span>
                      {v.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Message */}
              <div>
                <label className="mb-1 block text-sm font-medium">Message</label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="What did they do that was great?"
                  rows={3}
                  className="w-full rounded-xl border bg-muted/40 px-4 py-2.5 text-sm outline-none placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring"
                />
              </div>

              <button
                type="submit"
                disabled={!selected || !message.trim() || isPending}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
                {isPending ? "Sending..." : "Send kudos"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
