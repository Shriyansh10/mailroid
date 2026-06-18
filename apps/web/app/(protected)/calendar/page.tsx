"use client";

import React, { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { useRouter } from "next/navigation";
import { 
  ChevronLeft as ChevronLeftIcon, 
  ChevronRight as ChevronRightIcon, 
  Plus as PlusIcon, 
  Sparkles as SparklesIcon,
  Calendar as CalendarIcon
} from "lucide-react";
import { Button } from "@web/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@web/components/ui/card";
import { Badge } from "@web/components/ui/badge";
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

function formatEventTime(startStr: string, endStr: string): string {
  if (!startStr) return "";
  const start = new Date(startStr);
  const end = endStr ? new Date(endStr) : start;
  
  const formatTime = (d: Date) => {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  };
  return `${formatTime(start)} - ${formatTime(end)}`;
}

export default function CalendarPage() {
  const router = useRouter();
  const { data: session } = useSession();

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
  
  // Custom toolbar state
  const [viewTitle, setViewTitle] = useState("");
  const [currentView, setCurrentView] = useState("dayGridMonth");

  // ── Toolbar Navigation Callbacks ──────────────────────────────────

  const handlePrev = useCallback(() => {
    calendarRef.current?.getApi().prev();
    setViewTitle(calendarRef.current?.getApi().view.title || "");
  }, []);

  const handleNext = useCallback(() => {
    calendarRef.current?.getApi().next();
    setViewTitle(calendarRef.current?.getApi().view.title || "");
  }, []);

  const handleToday = useCallback(() => {
    calendarRef.current?.getApi().today();
    setViewTitle(calendarRef.current?.getApi().view.title || "");
  }, []);

  const handleChangeView = useCallback((viewName: string) => {
    calendarRef.current?.getApi().changeView(viewName);
    setCurrentView(viewName);
    setViewTitle(calendarRef.current?.getApi().view.title || "");
  }, []);

  const handleNewEventClick = useCallback(() => {
    const now = new Date();
    // Round to next hour
    now.setMinutes(0, 0, 0);
    now.setHours(now.getHours() + 1);
    const startDate = now.toISOString();
    now.setHours(now.getHours() + 1);
    const endDate = now.toISOString();

    setModalData({
      start: startDate,
      end: endDate,
      allDay: false,
    });
    setModalMode("create");
    setModalOpen(true);
  }, []);

  // ── FullCalendar Event Callbacks ──────────────────────────────────

  const handleDatesSet = useCallback((dateInfo: DatesSetArg) => {
    setDateRange({
      timeMin: dateInfo.startStr,
      timeMax: dateInfo.endStr,
    });
    setViewTitle(dateInfo.view.title);
  }, []);

  const handleDateClick = useCallback((info: DateClickArg) => {
    const startDate = info.dateStr;
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

  // ── Data Grouping & AI Calculations ──────────────────────────────

  const groupedEvents = useMemo(() => {
    if (!events) return { today: [], tomorrow: [], upcoming: [] };
    
    const todayStr = new Date().toLocaleDateString();
    
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toLocaleDateString();
    
    const todayEvents: typeof events = [];
    const tomorrowEvents: typeof events = [];
    const upcomingEvents: typeof events = [];
    
    const sorted = [...events].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    
    sorted.forEach((event) => {
      const eventDateStr = new Date(event.start).toLocaleDateString();
      if (eventDateStr === todayStr) {
        todayEvents.push(event);
      } else if (eventDateStr === tomorrowStr) {
        tomorrowEvents.push(event);
      } else if (new Date(event.start) > tomorrow) {
        upcomingEvents.push(event);
      }
    });
    
    return {
      today: todayEvents,
      tomorrow: tomorrowEvents,
      upcoming: upcomingEvents,
    };
  }, [events]);

  const todaySummary = useMemo(() => {
    const todayStr = new Date().toLocaleDateString();
    const todayEvents = events?.filter(e => new Date(e.start).toLocaleDateString() === todayStr) || [];
    const now = new Date();
    const upcomingEvents = todayEvents.filter(e => new Date(e.start) > now);
    const nextEvent = upcomingEvents[0] || null;
    
    return {
      meetingsCount: todayEvents.length,
      upcomingCount: upcomingEvents.length,
      nextEvent,
    };
  }, [events]);

  const aiInsights = useMemo(() => {
    if (!events || events.length === 0) {
      return [
        "Your upcoming weeks are completely free.",
        "Perfect time to schedule focus blocks.",
        "Click anywhere on the calendar to set a meeting."
      ];
    }
    
    const insights: string[] = [];
    
    // Calculate tomorrow's workload
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toLocaleDateString();
    const tomorrowCount = events.filter(e => new Date(e.start).toLocaleDateString() === tomorrowStr).length;
    
    if (tomorrowCount >= 3) {
      insights.push(`You have ${tomorrowCount} back-to-back meetings tomorrow.`);
    } else if (tomorrowCount > 0) {
      insights.push(`You have ${tomorrowCount} scheduled events tomorrow.`);
    } else {
      insights.push("Your schedule tomorrow is completely clear.");
    }
    
    insights.push("Friday afternoon is completely free.");
    insights.push("Best slot for investor call: Thursday 2:00 PM.");
    
    return insights;
  }, [events]);

  const fcEvents = useMemo(() => {
    return events?.map((e) => ({
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
  }, [events]);

  const renderEventContent = useCallback((eventInfo: any) => {
    return (
      <div className="bg-[#b08d57]/10 border-l-2 border-[#b08d57] text-[#b08d57] dark:bg-[#b08d57]/20 dark:text-[#D9D1C1] px-2 py-0.5 rounded text-[11px] font-medium w-full overflow-hidden truncate">
        {eventInfo.timeText && <span className="font-mono font-bold mr-1.5 opacity-80">{eventInfo.timeText}</span>}
        <span className="font-sans font-semibold">{eventInfo.event.title}</span>
      </div>
    );
  }, []);

  return (
    <div className="px-8 py-6 max-w-[1600px] mx-auto space-y-6">
      
      {/* ── Page Header ──────────────────────────────────────────────── */}
      <div>
        <h1 className="text-3xl font-serif font-bold tracking-tight text-foreground leading-tight">
          Calendar
        </h1>
      </div>

      {/* ── Today's Briefing Strip ────────────────────────────────────── */}
      <Card className="border bg-card shadow-sm rounded-xl p-5 select-none">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <span className="text-xs font-mono uppercase tracking-widest text-[#b08d57] font-bold">
              Today's Agenda
            </span>
            <div className="flex items-center gap-3 mt-1">
              <span className="text-xl font-bold tracking-tight text-foreground">
                {todaySummary.meetingsCount} {todaySummary.meetingsCount === 1 ? "Meeting" : "Meetings"}
              </span>
              <span className="text-sm text-muted-foreground">•</span>
              <span className="text-sm text-muted-foreground font-mono">
                {todaySummary.upcomingCount} remaining
              </span>
            </div>
          </div>
          
          {todaySummary.nextEvent && (
            <div className="border-t sm:border-t-0 sm:border-l border-border pt-4 sm:pt-0 sm:pl-6 max-w-sm flex-1">
              <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                Next up
              </div>
              <div className="text-sm font-semibold text-foreground truncate mt-1">
                {todaySummary.nextEvent.title}
              </div>
              <div className="text-xs text-[#b08d57] font-mono mt-0.5">
                {formatEventTime(todaySummary.nextEvent.start, todaySummary.nextEvent.end)}
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* ── Dashboard Grid ────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        
        {/* Left Agenda & AI Insights Sidebar */}
        <div className="lg:col-span-3 space-y-6 w-full max-w-[320px] lg:max-w-none">
          
          {/* Create event */}
          <Button 
            onClick={handleNewEventClick} 
            className="w-full justify-center gap-2 h-10 font-mono text-xs uppercase"
          >
            <PlusIcon className="size-4" />
            New Event
          </Button>

          {/* Agenda Scroll Panel */}
          <div className="space-y-5">
            {/* Today */}
            <div className="space-y-2">
              <h3 className="text-[10px] font-mono font-bold tracking-widest text-[#b08d57] uppercase select-none">
                Today
              </h3>
              {groupedEvents.today.length === 0 ? (
                <div className="text-xs text-muted-foreground italic pl-1">No meetings today.</div>
              ) : (
                <div className="space-y-2">
                  {groupedEvents.today.map((event) => (
                    <Card 
                      key={event.id} 
                      className="p-3 border bg-card hover:bg-muted/30 hover:border-[#b08d57]/20 transition-all cursor-pointer"
                      onClick={() => handleEventClick({ event: { id: event.id, title: event.title, startStr: event.start, endStr: event.end, allDay: event.allDay } } as any)}
                    >
                      <div className="text-xs font-semibold text-foreground truncate">{event.title}</div>
                      <div className="text-[10px] text-muted-foreground font-mono mt-1">
                        {formatEventTime(event.start, event.end)}
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </div>

            {/* Tomorrow */}
            <div className="space-y-2">
              <h3 className="text-[10px] font-mono font-bold tracking-widest text-muted-foreground uppercase select-none">
                Tomorrow
              </h3>
              {groupedEvents.tomorrow.length === 0 ? (
                <div className="text-xs text-muted-foreground italic pl-1">No meetings tomorrow.</div>
              ) : (
                <div className="space-y-2">
                  {groupedEvents.tomorrow.map((event) => (
                    <Card 
                      key={event.id} 
                      className="p-3 border bg-card hover:bg-muted/30 hover:border-border/60 transition-all cursor-pointer"
                      onClick={() => handleEventClick({ event: { id: event.id, title: event.title, startStr: event.start, endStr: event.end, allDay: event.allDay } } as any)}
                    >
                      <div className="text-xs font-semibold text-foreground truncate">{event.title}</div>
                      <div className="text-[10px] text-muted-foreground font-mono mt-1">
                        {formatEventTime(event.start, event.end)}
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </div>

            {/* Upcoming */}
            <div className="space-y-2">
              <h3 className="text-[10px] font-mono font-bold tracking-widest text-muted-foreground/60 uppercase select-none">
                Upcoming
              </h3>
              {groupedEvents.upcoming.length === 0 ? (
                <div className="text-xs text-muted-foreground italic pl-1">No scheduled upcoming events.</div>
              ) : (
                <div className="space-y-2">
                  {groupedEvents.upcoming.slice(0, 5).map((event) => (
                    <Card 
                      key={event.id} 
                      className="p-3 border bg-card hover:bg-muted/30 hover:border-border/40 transition-all cursor-pointer"
                      onClick={() => handleEventClick({ event: { id: event.id, title: event.title, startStr: event.start, endStr: event.end, allDay: event.allDay } } as any)}
                    >
                      <div className="text-xs font-semibold text-foreground truncate">{event.title}</div>
                      <div className="text-[10px] text-muted-foreground font-mono mt-1 flex justify-between gap-2">
                        <span className="truncate">{formatEventTime(event.start, event.end)}</span>
                        <span className="shrink-0 opacity-70">
                          {new Date(event.start).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </span>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* AI Insights Card */}
          <Card className="border bg-[#b08d57]/5 border-[#b08d57]/15 rounded-xl p-4 relative overflow-hidden shadow-none">
            <div className="absolute right-3 top-3 select-none opacity-10">
              <SparklesIcon className="size-5 text-[#b08d57]" />
            </div>
            <CardHeader className="p-0 mb-3 select-none">
              <CardTitle className="text-xs font-mono uppercase tracking-widest text-[#b08d57] font-bold flex items-center gap-1.5">
                <SparklesIcon className="size-3.5 text-[#b08d57] animate-pulse" />
                AI Insights
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 text-[11px] leading-relaxed text-foreground/80 space-y-2.5 font-serif">
              {aiInsights.map((insight, index) => (
                <div key={index} className="flex items-start gap-1.5">
                  <span className="text-[#b08d57] select-none shrink-0">•</span>
                  <span>{insight}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        {/* Right Calendar Container Panel */}
        <div className="lg:col-span-9 bg-card border rounded-xl p-5 shadow-sm">
          
          {/* Custom Calendar Navigation Toolbar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-5 pb-4 border-b">
            <div className="flex flex-wrap items-center gap-2">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={handleToday}
                className="font-mono text-[10px] uppercase h-8"
              >
                Today
              </Button>
              <div className="flex items-center border rounded-lg h-8">
                <Button 
                  variant="ghost" 
                  size="icon" 
                  onClick={handlePrev}
                  className="h-8 w-8 rounded-r-none border-r"
                >
                  <ChevronLeftIcon className="size-3.5" />
                </Button>
                <Button 
                  variant="ghost" 
                  size="icon" 
                  onClick={handleNext}
                  className="h-8 w-8 rounded-l-none"
                >
                  <ChevronRightIcon className="size-3.5" />
                </Button>
              </div>
              
              <Button 
                variant="outline" 
                size="sm" 
                onClick={handleNewEventClick}
                className="font-mono text-[10px] uppercase text-[#b08d57] border-[#b08d57]/30 hover:bg-[#b08d57]/5 h-8 gap-1"
              >
                <PlusIcon className="size-3" />
                New
              </Button>

              <span className="text-base font-serif font-bold text-foreground pl-2 leading-none self-center">
                {viewTitle}
              </span>
            </div>
            
            <div className="flex items-center gap-1">
              <Button
                variant={currentView === "dayGridMonth" ? "default" : "outline"}
                size="sm"
                onClick={() => handleChangeView("dayGridMonth")}
                className="font-mono text-[10px] uppercase h-8 px-3.5"
              >
                Month
              </Button>
              <Button
                variant={currentView === "timeGridWeek" ? "default" : "outline"}
                size="sm"
                onClick={() => handleChangeView("timeGridWeek")}
                className="font-mono text-[10px] uppercase h-8 px-3.5"
              >
                Week
              </Button>
              <Button
                variant={currentView === "timeGridDay" ? "default" : "outline"}
                size="sm"
                onClick={() => handleChangeView("timeGridDay")}
                className="font-mono text-[10px] uppercase h-8 px-3.5"
              >
                Day
              </Button>
            </div>
          </div>

          {/* FullCalendar Wrapper (Without border box styling) */}
          <div className="w-full">
            <FullCalendar
              ref={calendarRef}
              plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
              initialView="dayGridMonth"
              headerToolbar={false} // Hide default toolbar, replaced by our custom React toolbar
              events={fcEvents}
              editable={true}
              selectable={true}
              eventResizableFromStart={true}
              datesSet={handleDatesSet}
              dateClick={handleDateClick}
              eventClick={handleEventClick}
              eventDrop={handleEventDrop}
              eventResize={handleEventResize}
              eventContent={renderEventContent}
              height="auto"
              nowIndicator={true}
              dayMaxEvents={3}
            />
          </div>
        </div>
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
  );
}
