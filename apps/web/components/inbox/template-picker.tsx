"use client";

import { useState } from "react";
import { LayoutTemplateIcon, CalendarClockIcon } from "lucide-react";

import { Button } from "@web/components/ui/button";
import { Badge } from "@web/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@web/components/ui/popover";
import {
  useMailTemplateCategories,
  useMailTemplates,
} from "@web/hooks/api/mail-templates";

export type MailTemplate = NonNullable<
  ReturnType<typeof useMailTemplates>["data"]
>[number];

export function TemplatePicker({
  onSelect,
  disabled,
}: {
  onSelect: (template: MailTemplate) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { data: categories } = useMailTemplateCategories();
  const { data: templates, isLoading } = useMailTemplates(); // all templates

  const byCategory = (categories ?? []).map((cat) => ({
    category: cat,
    items: (templates ?? []).filter((t) => t.categoryId === cat.id),
  }));

  const hasAny = (templates?.length ?? 0) > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled} className="gap-1.5">
          <LayoutTemplateIcon className="size-3.5" />
          Choose template
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-h-96 overflow-y-auto p-2">
        {isLoading ? (
          <p className="text-sm text-muted-foreground p-2">Loading…</p>
        ) : !hasAny ? (
          <p className="text-sm text-muted-foreground p-2">
            No templates yet. Create some in Settings → Email Templates.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {byCategory.map(({ category, items }) =>
              items.length === 0 ? null : (
                <div key={category.id} className="flex flex-col gap-1">
                  <p className="text-xs font-medium text-muted-foreground px-1">
                    {category.name}
                  </p>
                  {items.map((tpl) => (
                    <button
                      key={tpl.id}
                      type="button"
                      className="flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
                      onClick={() => {
                        onSelect(tpl);
                        setOpen(false);
                      }}
                    >
                      <span className="flex items-center gap-1.5 text-sm font-medium">
                        {tpl.name}
                        {tpl.includesMeeting && (
                          <Badge variant="secondary" className="gap-1">
                            <CalendarClockIcon className="size-3" />
                            Meeting
                          </Badge>
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground truncate max-w-full">
                        {tpl.subject}
                      </span>
                    </button>
                  ))}
                </div>
              ),
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
