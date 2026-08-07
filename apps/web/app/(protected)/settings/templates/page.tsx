"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import {
  ArrowLeftIcon,
  LayoutTemplateIcon,
  PlusIcon,
  Trash2Icon,
  MoreVerticalIcon,
  PencilIcon,
  CalendarClockIcon,
} from "lucide-react";

import {
  useMailTemplateCategories,
  useCreateCategory,
  useDeleteCategory,
  useMailTemplates,
  useTemplateCount,
  useCreateTemplate,
  useUpdateTemplate,
  useDeleteTemplate,
} from "@web/hooks/api/mail-templates";
import { Button } from "@web/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@web/components/ui/card";
import { Badge } from "@web/components/ui/badge";
import { Input } from "@web/components/ui/input";
import { Label } from "@web/components/ui/label";
import { Textarea } from "@web/components/ui/textarea";
import { Switch } from "@web/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@web/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@web/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@web/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@web/components/ui/dropdown-menu";

type TemplateRow = NonNullable<ReturnType<typeof useMailTemplates>["data"]>[number];

// ── Category create form ────────────────────────────────────────────

const categoryFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
});
type CategoryFormValues = z.infer<typeof categoryFormSchema>;

function CategoryDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (categoryId: string) => void;
}) {
  const { createCategoryAsync, isPending } = useCreateCategory();
  const { register, handleSubmit, reset, formState: { errors } } =
    useForm<CategoryFormValues>({
      resolver: zodResolver(categoryFormSchema),
      defaultValues: { name: "" },
    });

  useEffect(() => {
    if (open) reset({ name: "" });
  }, [open, reset]);

  const onSubmit = async (values: CategoryFormValues) => {
    try {
      const category = await createCategoryAsync(values);
      toast.success("Category created");
      onCreated(category.id);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create category");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New category</DialogTitle>
          <DialogDescription>Group templates by use-case, e.g. &quot;Sales&quot;.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="category-name">Name</Label>
            <Input id="category-name" placeholder="Sales" autoFocus {...register("name")} />
            {errors.name && (
              <p className="text-destructive text-sm">{errors.name.message}</p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Template create/edit form ───────────────────────────────────────

const templateFormSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(100),
    subject: z.string().trim().min(1, "Subject is required"),
    body: z.string().min(1, "Body is required"),
    includesMeeting: z.boolean(),
    meetingDurationMinutes: z.number().int().positive().optional(),
    meetingLocation: z.string().trim().optional(),
    meetingDescription: z.string().trim().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.includesMeeting && !data.meetingDurationMinutes) {
      ctx.addIssue({
        code: "custom",
        path: ["meetingDurationMinutes"],
        message: "Duration is required when a meeting is included.",
      });
    }
  });
type TemplateFormValues = z.infer<typeof templateFormSchema>;

const EMPTY_TEMPLATE_FORM: TemplateFormValues = {
  name: "",
  subject: "",
  body: "",
  includesMeeting: false,
  meetingDurationMinutes: undefined,
  meetingLocation: "",
  meetingDescription: "",
};

function TemplateDialog({
  open,
  onOpenChange,
  categoryId,
  categoryName,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categoryId: string;
  categoryName: string;
  editing: TemplateRow | null;
}) {
  const { createTemplateAsync, isPending: creating } = useCreateTemplate();
  const { updateTemplateAsync, isPending: updating } = useUpdateTemplate();
  const isPending = creating || updating;

  const { register, handleSubmit, control, reset, watch, formState: { errors } } =
    useForm<TemplateFormValues>({
      resolver: zodResolver(templateFormSchema),
      defaultValues: EMPTY_TEMPLATE_FORM,
    });

  const includesMeeting = watch("includesMeeting");

  useEffect(() => {
    if (!open) return;
    reset(
      editing
        ? {
            name: editing.name,
            subject: editing.subject,
            body: editing.body,
            includesMeeting: editing.includesMeeting,
            meetingDurationMinutes: editing.meetingDurationMinutes ?? undefined,
            meetingLocation: editing.meetingLocation ?? "",
            meetingDescription: editing.meetingDescription ?? "",
          }
        : EMPTY_TEMPLATE_FORM,
    );
  }, [open, editing, reset]);

  const onSubmit = async (values: TemplateFormValues) => {
    const payload = {
      categoryId,
      name: values.name,
      subject: values.subject,
      body: values.body,
      includesMeeting: values.includesMeeting,
      meetingDurationMinutes: values.includesMeeting
        ? values.meetingDurationMinutes
        : undefined,
      meetingLocation: values.includesMeeting
        ? values.meetingLocation || undefined
        : undefined,
      meetingDescription: values.includesMeeting
        ? values.meetingDescription || undefined
        : undefined,
    };

    try {
      if (editing) {
        await updateTemplateAsync({ id: editing.id, ...payload });
        toast.success("Template saved");
      } else {
        await createTemplateAsync(payload);
        toast.success("Template created");
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save template");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit template" : "New template"}</DialogTitle>
          <DialogDescription>In {categoryName}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="template-name">Name</Label>
            <Input
              id="template-name"
              placeholder="Sales call intro"
              autoFocus
              {...register("name")}
            />
            {errors.name && <p className="text-destructive text-sm">{errors.name.message}</p>}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="template-subject">Subject</Label>
            <Input
              id="template-subject"
              placeholder="Following up on our call"
              {...register("subject")}
            />
            {errors.subject && (
              <p className="text-destructive text-sm">{errors.subject.message}</p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="template-body">Body</Label>
            <Textarea
              id="template-body"
              placeholder="Hi ,&#10;&#10;Thanks for your time today..."
              rows={8}
              // field-sizing-content on the base Textarea makes this grow to
              // fit, so a long template pushes "Create template" off-screen
              // and scrolls the dialog instead of the text box. Cap it.
              className="max-h-[45dvh] overflow-y-auto"
              {...register("body")}
            />
            {errors.body && <p className="text-destructive text-sm">{errors.body.message}</p>}
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label htmlFor="template-meeting">Include a meeting</Label>
              <p className="text-xs text-muted-foreground">
                Store meeting defaults for when this template is used later.
              </p>
            </div>
            <Controller
              control={control}
              name="includesMeeting"
              render={({ field }) => (
                <Switch
                  id="template-meeting"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              )}
            />
          </div>

          {includesMeeting && (
            <div className="flex flex-col gap-4 rounded-lg border p-3">
              <div className="grid gap-2">
                <Label htmlFor="template-duration">Duration (minutes)</Label>
                <Input
                  id="template-duration"
                  type="number"
                  min={1}
                  placeholder="30"
                  {...register("meetingDurationMinutes", { valueAsNumber: true })}
                />
                {errors.meetingDurationMinutes && (
                  <p className="text-destructive text-sm">
                    {errors.meetingDurationMinutes.message}
                  </p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="template-location">Location (optional)</Label>
                <Input
                  id="template-location"
                  placeholder="Google Meet"
                  {...register("meetingLocation")}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="template-meeting-description">Description (optional)</Label>
                <Textarea
                  id="template-meeting-description"
                  rows={2}
                  {...register("meetingDescription")}
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving…" : editing ? "Save changes" : "Create template"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Page ─────────────────────────────────────────────────────────────

type DeleteTarget =
  | { type: "category"; id: string; name: string; templateCount: number }
  | { type: "template"; id: string; name: string };

export default function EmailTemplatesSettingsPage() {
  const router = useRouter();

  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<TemplateRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const { data: categories, isLoading: categoriesLoading } = useMailTemplateCategories();
  const { data: templates, isLoading: templatesLoading } = useMailTemplates(
    selectedCategoryId ?? undefined,
  );
  const { data: countData } = useTemplateCount();
  const { deleteCategoryAsync, isPending: deletingCategory } = useDeleteCategory();
  const { deleteTemplateAsync, isPending: deletingTemplate } = useDeleteTemplate();

  // Auto-select the first category once categories load, if none chosen yet.
  useEffect(() => {
    if (!selectedCategoryId && categories && categories[0]) {
      setSelectedCategoryId(categories[0].id);
    }
  }, [categories, selectedCategoryId]);

  const selectedCategory = categories?.find((c) => c.id === selectedCategoryId) ?? null;
  const count = countData?.count ?? 0;
  const max = countData?.max ?? 10;
  const atCap = count >= max;

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.type === "category") {
        await deleteCategoryAsync({ id: deleteTarget.id });
        toast.success("Category deleted");
        if (selectedCategoryId === deleteTarget.id) {
          const remaining = categories?.filter((c) => c.id !== deleteTarget.id) ?? [];
          setSelectedCategoryId(remaining[0]?.id ?? null);
        }
      } else {
        await deleteTemplateAsync({ id: deleteTarget.id });
        toast.success("Template deleted");
      }
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground px-6 py-10">
      <div className="max-w-2xl mx-auto flex flex-col gap-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/inbox")}
          className="self-start gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
          Back to Inbox
        </Button>

        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center size-10 rounded-lg bg-muted">
            <LayoutTemplateIcon className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Email Templates</h1>
            <p className="text-sm text-muted-foreground">
              Prebuilt drafts you can reuse when composing.
            </p>
          </div>
        </div>

        {/* Category picker */}
        <Card>
          <CardContent className="flex items-center gap-2 pt-6">
            {categoriesLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : categories && categories.length > 0 ? (
              <>
                <Select
                  value={selectedCategoryId ?? undefined}
                  onValueChange={setSelectedCategoryId}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a category" />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map((cat) => (
                      <SelectItem key={cat.id} value={cat.id}>
                        {cat.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  disabled={!selectedCategory}
                  onClick={() =>
                    selectedCategory &&
                    setDeleteTarget({
                      type: "category",
                      id: selectedCategory.id,
                      name: selectedCategory.name,
                      templateCount: templates?.length ?? 0,
                    })
                  }
                >
                  <Trash2Icon className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-1.5"
                  onClick={() => setCategoryDialogOpen(true)}
                >
                  <PlusIcon className="size-3.5" />
                  New category
                </Button>
              </>
            ) : (
              <div className="flex w-full flex-col items-start gap-2">
                <p className="text-sm text-muted-foreground">
                  Create a category to get started.
                </p>
                <Button
                  type="button"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setCategoryDialogOpen(true)}
                >
                  <PlusIcon className="size-3.5" />
                  New category
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Count banner */}
        <div className="-mt-2">
          <p className="text-xs text-muted-foreground">
            {count}/{max} templates used
          </p>
          {atCap && (
            <p className="text-xs text-muted-foreground">
              Limit reached — delete a template to create another.
            </p>
          )}
        </div>

        {/* Template list */}
        {selectedCategory && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
              <div>
                <CardTitle>{selectedCategory.name}</CardTitle>
                <CardDescription>Templates in this category.</CardDescription>
              </div>
              <Button
                type="button"
                size="sm"
                className="gap-1.5 shrink-0"
                disabled={atCap}
                onClick={() => {
                  setEditingTemplate(null);
                  setTemplateDialogOpen(true);
                }}
              >
                <PlusIcon className="size-3.5" />
                New template
              </Button>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {templatesLoading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : templates && templates.length > 0 ? (
                templates.map((tpl) => (
                  <div
                    key={tpl.id}
                    className="flex items-center justify-between gap-3 rounded-lg border p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm truncate">{tpl.name}</p>
                        {tpl.includesMeeting && (
                          <Badge variant="secondary" className="shrink-0">
                            <CalendarClockIcon />
                            Meeting
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{tpl.subject}</p>
                      <p className="text-xs text-muted-foreground">
                        Updated {formatDistanceToNow(new Date(tpl.updatedAt), { addSuffix: true })}
                      </p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button type="button" variant="ghost" size="icon" className="shrink-0">
                          <MoreVerticalIcon className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          className="cursor-pointer"
                          onClick={() => {
                            setEditingTemplate(tpl);
                            setTemplateDialogOpen(true);
                          }}
                        >
                          <PencilIcon className="mr-2 h-4 w-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="cursor-pointer text-red-600 focus:text-red-600"
                          onClick={() =>
                            setDeleteTarget({ type: "template", id: tpl.id, name: tpl.name })
                          }
                        >
                          <Trash2Icon className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  No templates in this category yet.
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <CategoryDialog
        open={categoryDialogOpen}
        onOpenChange={setCategoryDialogOpen}
        onCreated={setSelectedCategoryId}
      />

      {selectedCategory && (
        <TemplateDialog
          open={templateDialogOpen}
          onOpenChange={(open) => {
            setTemplateDialogOpen(open);
            if (!open) setEditingTemplate(null);
          }}
          categoryId={selectedCategory.id}
          categoryName={selectedCategory.name}
          editing={editingTemplate}
        />
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &quot;{deleteTarget?.name}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.type === "category"
                ? `This will permanently delete ${deleteTarget.templateCount} template${
                    deleteTarget.templateCount === 1 ? "" : "s"
                  } inside it.`
                : "This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingCategory || deletingTemplate}>
              Cancel
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={deletingCategory || deletingTemplate}
              onClick={handleDeleteConfirm}
            >
              {deletingCategory || deletingTemplate ? "Deleting…" : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
