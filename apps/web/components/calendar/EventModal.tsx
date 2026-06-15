"use client";

import React, { useEffect } from "react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import DOMPurify from "dompurify";

interface EventModalProps {
  isOpen: boolean;
  mode: "create" | "edit";
  initialData?: {
    id?: string;
    title?: string;
    start?: string;
    end?: string;
    description?: string;
    location?: string;
    attendees?: string[];
    allDay?: boolean;
  };
  onSave: (data: {
    id?: string;
    title: string;
    start: string;
    end: string;
    description?: string;
    location?: string;
    attendees?: string[];
    allDay?: boolean;
  }) => void;
  onDelete?: (id: string) => void;
  onClose: () => void;
}

const sanitizeText = (val: string | undefined) => {
  if (!val) return "";
  return DOMPurify.sanitize(val, { ALLOWED_TAGS: [] }).trim();
};

const formSchema = z
  .object({
    title: z.string().transform(sanitizeText).optional(),
    start: z.string().min(1, "Start time is required"),
    end: z.string().min(1, "End time is required"),
    description: z.string().transform(sanitizeText).optional(),
    location: z.string().transform(sanitizeText).optional(),
    attendeesStr: z
      .string()
      .transform(sanitizeText)
      .optional()
      .refine((val) => {
        if (!val) return true;
        const emails = val.split(",").map((e) => e.trim()).filter(Boolean);
        return emails.every((email) => z.string().email().safeParse(email).success);
      }, "Please enter valid email addresses separated by commas"),
    allDay: z.boolean().optional(),
  })
  .refine(
    (data) => {
      if (data.start && data.end) {
        return new Date(data.end) >= new Date(data.start);
      }
      return true;
    },
    {
      message: "End time must be after start time",
      path: ["end"],
    }
  );

type FormValues = z.infer<typeof formSchema>;

/**
 * Format an ISO string or date string for datetime-local input.
 * Returns "YYYY-MM-DDTHH:mm" format.
 */
function toDateTimeLocal(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 16);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function EventModal({
  isOpen,
  mode,
  initialData,
  onSave,
  onDelete,
  onClose,
}: EventModalProps) {
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      title: "",
      start: "",
      end: "",
      description: "",
      location: "",
      attendeesStr: "",
      allDay: false,
    },
  });

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = form;
  const allDay = watch("allDay");

  // Reset form when modal opens or initialData changes
  useEffect(() => {
    if (isOpen) {
      if (initialData) {
        const startDt = toDateTimeLocal(initialData.start ?? "");
        const endDt = toDateTimeLocal(initialData.end ?? "");
        const isAllDay = initialData.allDay ?? false;

        reset({
          title: initialData.title ?? "",
          start: isAllDay ? startDt.slice(0, 10) : startDt,
          end: isAllDay ? endDt.slice(0, 10) : endDt,
          description: initialData.description ?? "",
          location: initialData.location ?? "",
          attendeesStr: initialData.attendees?.join(", ") ?? "",
          allDay: isAllDay,
        });
      } else {
        reset({
          title: "",
          start: "",
          end: "",
          description: "",
          location: "",
          attendeesStr: "",
          allDay: false,
        });
      }
    }
  }, [isOpen, initialData, reset]);

  // Adjust start/end format when allDay toggles
  useEffect(() => {
    if (!isOpen) return;
    const s = form.getValues("start");
    const e = form.getValues("end");
    if (allDay) {
      if (s && s.includes("T")) setValue("start", s.split("T")[0] ?? "");
      if (e && e.includes("T")) setValue("end", e.split("T")[0] ?? "");
    } else {
      if (s && !s.includes("T")) setValue("start", `${s}T00:00`);
      if (e && !e.includes("T")) setValue("end", `${e}T00:00`);
    }
  }, [allDay, isOpen, setValue, form]);

  if (!isOpen) return null;

  const onSubmit = (data: FormValues) => {
    const attendees = (data.attendeesStr || "")
      .split(",")
      .map((e) => e.trim())
      .filter((email) => z.string().email().safeParse(email).success);

    onSave({
      id: initialData?.id,
      title: data.title || "(No title)",
      start: new Date(data.start).toISOString(),
      end: data.end
        ? new Date(data.end).toISOString()
        : new Date(data.start).toISOString(),
      description: data.description || undefined,
      location: data.location || undefined,
      attendees: attendees.length > 0 ? attendees : undefined,
      allDay: data.allDay ?? false,
    });
  };

  const handleDelete = () => {
    if (initialData?.id && onDelete) {
      onDelete(initialData.id);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(255, 255, 255, 0.5)",
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: "#1a1a2e",
          borderRadius: "12px",
          padding: "1.5rem",
          width: "100%",
          maxWidth: "480px",
          border: "1px solid #333",
          boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: "0 0 1rem", fontSize: "1.25rem", color: "#e0e0e0" }}>
          {mode === "create" ? "Create Event" : "Edit Event"}
        </h2>

        <form
          onSubmit={handleSubmit(onSubmit)}
          style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
        >
          {/* Title */}
          <div>
            <label style={labelStyle}>Title</label>
            <input
              type="text"
              {...register("title")}
              placeholder="Event title"
              style={inputStyle}
              autoFocus
            />
          </div>

          {/* All Day */}
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <input type="checkbox" id="allDay" {...register("allDay")} />
            <label htmlFor="allDay" style={{ color: "#ccc", fontSize: "0.875rem" }}>
              All day
            </label>
          </div>

          {/* Start */}
          <div>
            <label style={labelStyle}>Start</label>
            <input
              type={allDay ? "date" : "datetime-local"}
              {...register("start")}
              style={inputStyle}
            />
            {errors.start && <span style={errorStyle}>{errors.start.message}</span>}
          </div>

          {/* End */}
          <div>
            <label style={labelStyle}>End</label>
            <input
              type={allDay ? "date" : "datetime-local"}
              {...register("end")}
              style={inputStyle}
            />
            {errors.end && <span style={errorStyle}>{errors.end.message}</span>}
          </div>

          {/* Guests */}
          <div>
            <label style={labelStyle}>Guests (valid emails only)</label>
            <input
              type="text"
              {...register("attendeesStr")}
              placeholder="email1@example.com, email2@example.com"
              style={inputStyle}
            />
            {errors.attendeesStr && <span style={errorStyle}>{errors.attendeesStr.message}</span>}
          </div>

          {/* Location */}
          <div>
            <label style={labelStyle}>Location</label>
            <input
              type="text"
              {...register("location")}
              placeholder="Meeting room / URL"
              style={inputStyle}
            />
          </div>

          {/* Description */}
          <div>
            <label style={labelStyle}>Description</label>
            <textarea
              {...register("description")}
              placeholder="Add description..."
              rows={3}
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </div>

          {/* Actions */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: "1.25rem",
              gap: "0.5rem",
            }}
          >
            <div>
              {mode === "edit" && onDelete && (
                <button
                  type="button"
                  onClick={handleDelete}
                  style={deleteButtonStyle}
                >
                  Delete
                </button>
              )}
            </div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button type="button" onClick={onClose} style={cancelButtonStyle}>
                Cancel
              </button>
              <button type="submit" style={saveButtonStyle}>
                {mode === "create" ? "Create" : "Save"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.75rem",
  fontWeight: 600,
  color: "#999",
  marginBottom: "0.25rem",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.75rem",
  backgroundColor: "#16213e",
  border: "1px solid #333",
  borderRadius: "6px",
  color: "#e0e0e0",
  fontSize: "0.875rem",
  outline: "none",
  boxSizing: "border-box",
};

const baseButtonStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  borderRadius: "6px",
  fontSize: "0.875rem",
  fontWeight: 500,
  cursor: "pointer",
  border: "none",
};

const saveButtonStyle: React.CSSProperties = {
  ...baseButtonStyle,
  backgroundColor: "#4361ee",
  color: "#fff",
};

const cancelButtonStyle: React.CSSProperties = {
  ...baseButtonStyle,
  backgroundColor: "transparent",
  color: "#999",
  border: "1px solid #333",
};

const deleteButtonStyle: React.CSSProperties = {
  ...baseButtonStyle,
  backgroundColor: "#e74c3c",
  color: "#fff",
};

const errorStyle: React.CSSProperties = {
  color: "#e74c3c",
  fontSize: "0.75rem",
  marginTop: "0.25rem",
  display: "block",
};
