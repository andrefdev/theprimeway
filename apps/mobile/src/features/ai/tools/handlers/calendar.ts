import { apiClient } from '@shared/api/client';
import { CALENDAR } from '@shared/api/endpoints';
import { toast } from '@shared/lib/toast';
import type { ToolHandler, ToolResult } from '../types';

export interface CreateTimeBlockArgs {
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  description?: string;
  timeZone?: string;
}

export interface UpdateCalendarEventArgs {
  eventId: string;
  calendarId: string;
  eventTitle: string;
  title?: string;
  description?: string;
  location?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  timeZone?: string;
  addGoogleMeet?: boolean;
  removeGoogleMeet?: boolean;
  visibility?: 'default' | 'public' | 'private' | 'confidential';
}

export interface DeleteCalendarEventArgs {
  eventId: string;
  calendarId: string;
  eventTitle: string;
}

const NO_GOOGLE_RE = /no_google_account|no_calendar|No Google Calendar/i;

function deviceTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz || 'UTC';
  } catch {
    return 'UTC';
  }
}

function extractErrMsg(e: unknown): string {
  if (typeof e !== 'object' || e === null) return '';
  const err = e as {
    response?: { data?: { error?: string } };
    data?: { error?: string };
    message?: string;
  };
  return err.response?.data?.error ?? err.data?.error ?? err.message ?? '';
}

function noGoogleToast(t: (key: string, params?: Record<string, unknown>) => string) {
  toast.error(
    t('timeBlockNoGoogle', {
      defaultValue: 'Connect Google Calendar in Settings → Integrations first',
    })
  );
}

export const createTimeBlockHandler: ToolHandler<CreateTimeBlockArgs> = {
  name: 'createTimeBlock',
  execute: async (args, { queryClient, t }): Promise<ToolResult> => {
    try {
      const { data: response } = await apiClient.post(CALENDAR.TIME_BLOCK, {
        title: args.title,
        date: args.date,
        startTime: args.startTime,
        endTime: args.endTime,
        description: args.description,
        timeZone: args.timeZone || deviceTimeZone(),
      });
      const res = (response.data ?? response) as { eventId?: string };
      queryClient.invalidateQueries({ queryKey: ['calendar'] });
      toast.success(t('timeBlockCreated', { defaultValue: 'Time block scheduled' }));
      return { success: true, eventId: res.eventId };
    } catch (e) {
      const errMsg = extractErrMsg(e);
      if (NO_GOOGLE_RE.test(errMsg)) {
        noGoogleToast(t);
        return { error: 'no_google_account' };
      }
      throw e;
    }
  },
};

export const updateCalendarEventHandler: ToolHandler<UpdateCalendarEventArgs> = {
  name: 'updateCalendarEvent',
  execute: async (args, { queryClient, t }): Promise<ToolResult> => {
    try {
      const { eventId, calendarId, eventTitle: _eventTitle, timeZone: _tz, ...rest } = args;
      const body = { ...rest, timeZone: args.timeZone || deviceTimeZone() };
      const { data: response } = await apiClient.patch(CALENDAR.EVENT(calendarId, eventId), body);
      const event = (response.data ?? response) as { id?: string };
      queryClient.invalidateQueries({ queryKey: ['calendar'] });
      toast.success(t('eventUpdated', { defaultValue: 'Event updated' }));
      return { success: true, eventId: event.id };
    } catch (e) {
      const errMsg = extractErrMsg(e);
      if (NO_GOOGLE_RE.test(errMsg)) {
        noGoogleToast(t);
        return { error: 'no_google_account' };
      }
      throw e;
    }
  },
};

export const deleteCalendarEventHandler: ToolHandler<DeleteCalendarEventArgs> = {
  name: 'deleteCalendarEvent',
  execute: async (args, { queryClient, t }): Promise<ToolResult> => {
    try {
      await apiClient.delete(CALENDAR.EVENT(args.calendarId, args.eventId));
      queryClient.invalidateQueries({ queryKey: ['calendar'] });
      toast.success(t('eventDeleted', { defaultValue: 'Event deleted' }));
      return { success: true };
    } catch (e) {
      const errMsg = extractErrMsg(e);
      if (NO_GOOGLE_RE.test(errMsg)) {
        noGoogleToast(t);
        return { error: 'no_google_account' };
      }
      throw e;
    }
  },
};
