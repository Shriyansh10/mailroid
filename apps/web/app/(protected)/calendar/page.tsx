"use client";

import React, { useState, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { InboxIcon, LogOutIcon } from "lucide-react";
import { Button } from "@web/components/ui/button";
import { Avatar, AvatarImage, AvatarFallback } from "@web/components/ui/avatar";
import { authClient, useSession } from "@web/lib/auth-client";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import type { DateClickArg } from "@fullcalendar/interaction";
import type { EventClickArg, EventDropArg, DatesSetArg } from "@fullcalendar/core";
import type { EventResizeDoneArg } from "@fullcalendar/interaction";

import {
  useCalendarEvents,
  useCreateEvent,
  useUpdateEvent,
  useDeleteEvent,
} from "@web/hooks/api/calendar";
import EventModal from "@web/components/calendar/EventModal";

interface ModalData {
  id?: string;
  title?: string;
  start?: string;
  end?: string;
  description?: string;
  location?: string;
  attendees?: string[];
  allDay?: boolean;
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

export default function CalendarPage() {
  const router = useRouter();
  const { data: session } = useSession();

  const initials = useMemo(() => {
    const name = session?.user?.name;
    return name ? getInitials(name) : "?";
  }, [session?.user?.name]);

  const avatarUrl = session?.user?.image ?? null;

  const handleLogout = useCallback(async () => {
    await authClient.signOut();
    router.push("/sign-in");
  }, [router]);

  // Date range for current view
  const [dateRange, setDateRange] = useState({
    timeMin: new Date().toISOString(),
    timeMax: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  });

  // Fetch events for the visible range
  const { data: events, refetch } = useCalendarEvents(
    dateRange.timeMin,
    dateRange.timeMax
  );

  // Mutations
  const { createEventAsync } = useCreateEvent();
  const { updateEventAsync } = useUpdateEvent();
  const { deleteEventAsync } = useDeleteEvent();

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"create" | "edit">("create");
  const [modalData, setModalData] = useState<ModalData | undefined>(undefined);

  // Ref for the calendar API
  const calendarRef = useRef<FullCalendar>(null);

  // ── Callbacks ────────────────────────────────────────────────────

  /** Update date range when calendar view changes */
  const handleDatesSet = useCallback((dateInfo: DatesSetArg) => {
    setDateRange({
      timeMin: dateInfo.startStr,
      timeMax: dateInfo.endStr,
    });
  }, []);

  /** Click empty slot → open create modal */
  const handleDateClick = useCallback((info: DateClickArg) => {
    const startDate = info.dateStr;
    // Default end = 1 hour after start for timed, same day for all-day
    const isAllDay = info.allDay;
    let endDate: string;

    if (isAllDay) {
      endDate = startDate;
    } else {
      const start = new Date(startDate);
      start.setHours(start.getHours() + 1);
      endDate = start.toISOString();
    }

    setModalData({
      start: startDate,
      end: endDate,
      allDay: isAllDay,
    });
    setModalMode("create");
    setModalOpen(true);
  }, []);

  /** Click existing event → open edit modal */
  const handleEventClick = useCallback(
    (info: EventClickArg) => {
      const event = info.event;
      const matchedEvent = events?.find((e) => e.id === event.id);

      setModalData({
        id: event.id,
        title: event.title,
        start: event.startStr,
        end: event.endStr || event.startStr,
        allDay: event.allDay,
        description: matchedEvent?.description,
        location: matchedEvent?.location,
        attendees: matchedEvent?.attendees,
      });
      setModalMode("edit");
      setModalOpen(true);
    },
    [events]
  );

  /** Drag event to new time → update */
  const handleEventDrop = useCallback(
    async (info: EventDropArg) => {
      try {
        await updateEventAsync({
          id: info.event.id,
          title: info.event.title,
          start: info.event.startStr,
          end: info.event.endStr || info.event.startStr,
          allDay: info.event.allDay,
        });
        refetch();
      } catch {
        info.revert();
      }
    },
    [updateEventAsync, refetch]
  );

  /** Resize event → update end time */
  const handleEventResize = useCallback(
    async (info: EventResizeDoneArg) => {
      try {
        await updateEventAsync({
          id: info.event.id,
          title: info.event.title,
          start: info.event.startStr,
          end: info.event.endStr || info.event.startStr,
          allDay: info.event.allDay,
        });
        refetch();
      } catch {
        info.revert();
      }
    },
    [updateEventAsync, refetch]
  );
  const handleModalSave = useCallback(
    async (data: {
      id?: string;
      title: string;
      start: string;
      end: string;
      description?: string;
      location?: string;
      attendees?: string[];
      allDay?: boolean;
    }) => {
      try {
        if (modalMode === "create") {
          await createEventAsync({
            title: data.title,
            start: data.start,
            end: data.end,
            description: data.description,
            location: data.location,
            attendees: data.attendees,
            allDay: data.allDay,
          });
        } else if (data.id) {
          await updateEventAsync({
            id: data.id,
            title: data.title,
            start: data.start,
            end: data.end,
            description: data.description,
            location: data.location,
            attendees: data.attendees,
            allDay: data.allDay,
          });
        }
        setModalOpen(false);
        refetch();
      } catch (err) {
        console.error("Failed to save event:", err);
      }
    },
    [modalMode, createEventAsync, updateEventAsync, refetch]
  );

  /** Delete from modal */
  const handleModalDelete = useCallback(
    async (id: string) => {
      try {
        await deleteEventAsync({ id });
        setModalOpen(false);
        refetch();
      } catch (err) {
        console.error("Failed to delete event:", err);
      }
    },
    [deleteEventAsync, refetch]
  );

  // ── Transform events for FullCalendar ────────────────────────────

  const fcEvents =
    events?.map((e) => ({
      id: e.id,
      title: e.title,
      start: e.start,
      end: e.end,
      allDay: e.allDay,
      extendedProps: {
        description: e.description,
        location: e.location,
        attendees: e.attendees,
        meetLink: e.meetLink,
      },
    })) ?? [];

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="px-8 py-6">
      {/* Top bar: profile + nav + logout */}
      <div className="flex items-center gap-4 mb-6">
        <Avatar className="size-9 shrink-0 ring-2 ring-chart-1/50">
          {avatarUrl && <AvatarImage src={avatarUrl} alt={session?.user?.name ?? "User"} />}
          <AvatarFallback className="bg-chart-1 text-primary-foreground text-sm font-semibold">
            {initials}
          </AvatarFallback>
        </Avatar>

        <div className="flex-1" />

        <Button
          variant="outline"
          onClick={() => router.push("/inbox")}
          className="shrink-0 gap-2"
        >
          <InboxIcon className="size-4" />
          Inbox
        </Button>

        <Button
          variant="ghost"
          onClick={handleLogout}
          className="shrink-0"
        >
          <LogOutIcon className="size-4" />
          Logout
        </Button>
      </div>

    <div style={{ padding: "1.5rem", maxWidth: "1200px", margin: "0 auto" }}>
      <h1 style={{ marginBottom: "1rem", fontSize: "1.5rem", fontWeight: 600 }}>
        Calendar
      </h1>

      <div
        style={{
          backgroundColor: "#eeeeeeff",
          borderRadius: "12px",
          padding: "1rem",
          border: "1px solid #000000ff",
        }}
      >
        <FullCalendar
          ref={calendarRef}
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView="dayGridMonth"
          headerToolbar={{
            left: "prev,next today",
            center: "title",
            right: "dayGridMonth,timeGridWeek,timeGridDay",
          }}
          events={fcEvents}
          editable={true}
          selectable={true}
          eventResizableFromStart={true}
          datesSet={handleDatesSet}
          dateClick={handleDateClick}
          eventClick={handleEventClick}
          eventDrop={handleEventDrop}
          eventResize={handleEventResize}
          height="auto"
          nowIndicator={true}
          dayMaxEvents={3}
        />
      </div>

      <EventModal
        isOpen={modalOpen}
        mode={modalMode}
        initialData={modalData}
        onSave={handleModalSave}
        onDelete={handleModalDelete}
        onClose={() => setModalOpen(false)}
      />
    </div>
    </div>
  );
}
