import {
  invoke,
  transformTool,
  useKnowledgeSaveMutation,
  useNotifications,
  useSendToChat,
  useToast,
} from '@kontourai/station-sdk';
import DOMPurify from 'dompurify';
import { useEffect, useMemo, useState } from 'react';
import type {
  CalendarEvent,
  CalendarProps,
  MeetingDetails,
  SFDCContext,
} from './Calendar.types';
import type { EventModalData } from './CreateEventModal';
import { CreateEventModal } from './CreateEventModal';
import {
  detectMeetingProvider,
  getCacheKey,
  getFromCache,
  setCache,
} from './calendar-utils';
import { ConfirmModal } from './components/ConfirmModal';
import { SearchModal } from './components/SearchModal';
import { CRM_BASE_URL } from './constants';
import {
  calendarProvider,
  crmProvider,
  useCalendarEvents,
  useCreateEvent,
  useDeleteEvent,
  useUpdateEvent,
} from './data';
import { useSales } from './EnterpriseContext';
import { useProjectSlug } from './hooks/useProjectSlug';
import { log } from './log';
import { useLocalSalesState } from './SalesDataContext';
import { useCalendarNavigation } from './useCalendarNavigation';
import { useSalesContext } from './useSalesContext';
import './layout.css';

export function Calendar({ activeTab }: CalendarProps) {
  const salesContext = useSalesContext();
  const { state: salesState, setState: setSalesState } = useSales();
  const projectSlug = useProjectSlug();
  const { addEmailName, getNameForEmail } = useLocalSalesState();

  const { showToast } = useToast();
  const { notify } = useNotifications();
  const sendToChat = useSendToChat('enterprise-assistant');
  const notesSave = useKnowledgeSaveMutation(projectSlug!, 'notes');

  const {
    selectedDate,
    setSelectedDate,
    viewMonth,
    setViewMonth,
    selectedEventId,
    isUserSelected,
    selectEvent,
    autoSelectEvent,
    clearSelection,
    selectedCategories,
    setSelectedCategories,
    filterExpanded,
    setFilterExpanded,
    allDayExpanded,
    setAllDayExpanded,
    formatLocalDate,
  } = useCalendarNavigation(activeTab);

  const {
    data: rawEvents = [],
    isLoading: loading,
    error: eventsError,
  } = useCalendarEvents(selectedDate);
  const events: CalendarEvent[] = (rawEvents as any[]).map((e) => ({
    meetingId: e.id || e.meetingId,
    meetingChangeKey: e.changeKey || e.meetingChangeKey || '',
    subject: e.subject,
    start:
      typeof e.start === 'string' ? e.start : (e.start as Date).toISOString(),
    end: typeof e.end === 'string' ? e.end : (e.end as Date).toISOString(),
    location: e.location || '',
    organizer: e.organizer || '',
    status: e.status,
    isCanceled: e.isCancelled || e.isCanceled || false,
    categories: e.categories || [],
    isAllDay: e.isAllDay || false,
  }));

  const [todayEvents, setTodayEvents] = useState<CalendarEvent[]>([]);
  const [meetingDetails, setMeetingDetails] = useState<MeetingDetails | null>(
    null,
  );
  const [loadingDetails, setLoadingDetails] = useState(false);
  const error = eventsError ? (eventsError as Error).message : null;
  const [sfdcContext, setSfdcContext] = useState<SFDCContext | null>(null);
  const [loadingSFDC, setLoadingSFDC] = useState(false);
  const [showAllAttendees, setShowAllAttendees] = useState(false);
  const [contentExpanded, setContentExpanded] = useState(false);
  const [calendarCollapsed, setCalendarCollapsed] = useState(false);
  const [showAllTasks, setShowAllTasks] = useState(false);
  const [tasksCursor, setTasksCursor] = useState<string | undefined>();
  const [hidePastEvents, setHidePastEvents] = useState(false);
  const [hideCanceledEvents, setHideCanceledEvents] = useState(false);
  const [isNowLineVisible, setIsNowLineVisible] = useState(true);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [dismissedNotifications, setDismissedNotifications] = useState<
    Set<string>
  >(new Set());
  const [savedEventIds, setSavedEventIds] = useState<Set<string>>(new Set());
  const [showLogActivityModal, setShowLogActivityModal] = useState(false);
  const [showCreateEventModal, setShowCreateEventModal] = useState(false);
  const [eventModalData, setEventModalData] = useState<
    EventModalData | undefined
  >();
  const [confirmDeleteEvent, setConfirmDeleteEvent] =
    useState<CalendarEvent | null>(null);
  const createEvent = useCreateEvent();
  const updateEvent = useUpdateEvent();
  const deleteEvent = useDeleteEvent();
  const [selectedSfdcItem, setSelectedSfdcItem] = useState<{
    type: 'account' | 'opportunity' | 'campaign';
    data: any;
  } | null>(null);
  const [activityFormData, setActivityFormData] = useState({
    subject: '',
    activityType: '',
    activityDate: new Date().toISOString().split('T')[0],
    description: '',
  });
  const [loadingActivityPrefill, setLoadingActivityPrefill] = useState(false);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [submittingActivity, setSubmittingActivity] = useState(false);
  const [opportunityKeyword, setOpportunityKeyword] = useState('');
  const [loadingOpportunities, setLoadingOpportunities] = useState(false);
  const [hideClosedOpportunities, setHideClosedOpportunities] = useState(true);
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [searchModalType, _setSearchModalType] = useState<
    'account' | 'campaign' | 'opportunity'
  >('account');
  const [accountFilter, setAccountFilter] = useState('');
  const [showActivityDetailModal, setShowActivityDetailModal] = useState(false);
  const [selectedActivity, setSelectedActivity] = useState<any>(null);
  const [loadingActivityDetails, setLoadingActivityDetails] = useState(false);
  const [showAssignOppModal, setShowAssignOppModal] = useState(false);
  const [activityToAssign, setActivityToAssign] = useState<any>(null);
  const [assigningActivity, setAssigningActivity] = useState(false);
  const [meetingNotes, setMeetingNotes] = useState<string | null>(null);
  const [aiDraft, setAiDraft] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [oppFilterText, setOppFilterText] = useState('');

  const isToday = selectedDate.toDateString() === new Date().toDateString();

  useEffect(() => {
    if (sfdcContext?.suggestedKeyword && !opportunityKeyword) {
      setOpportunityKeyword(sfdcContext.suggestedKeyword);
    }
  }, [sfdcContext?.suggestedKeyword, opportunityKeyword]);

  useEffect(() => {
    if (!isToday) return;
    const updateTime = () => setCurrentTime(new Date());
    const msUntilNextMinute = 60000 - (Date.now() % 60000);
    let interval: ReturnType<typeof setInterval>;
    const timeout = setTimeout(() => {
      updateTime();
      interval = setInterval(updateTime, 60000);
    }, msUntilNextMinute);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, [isToday]);

  const upcomingNotification = useMemo(() => {
    if (!isToday || todayEvents.length === 0) return null;
    const now = new Date();
    const upcomingMeeting = todayEvents
      .filter((e) => !e.isAllDay)
      .find((e) => {
        const start = new Date(e.start);
        const minutesUntil = Math.round(
          (start.getTime() - now.getTime()) / 60000,
        );
        return minutesUntil > 0 && minutesUntil <= 30;
      });
    if (!upcomingMeeting) return null;
    const start = new Date(upcomingMeeting.start);
    const minutesUntil = Math.round((start.getTime() - now.getTime()) / 60000);
    const notificationId = `${upcomingMeeting.meetingId}-${minutesUntil}`;
    if (dismissedNotifications.has(notificationId)) return null;
    return { meeting: upcomingMeeting, minutesUntil, notificationId };
  }, [isToday, todayEvents, dismissedNotifications]);

  const selectedEvent =
    events.find((e) => e.meetingId === selectedEventId) ?? null;

  useEffect(() => {
    if (selectedEventId) {
      const saved = localStorage.getItem(`meeting-notes:${selectedEventId}`);
      setMeetingNotes(saved);
    } else {
      setMeetingNotes(null);
    }
    setAiDraft(null);
  }, [selectedEventId]);

  const allCategories = Array.from(
    new Set(events.flatMap((e) => e.categories || [])),
  );
  const hasUncategorized = events.some(
    (e) => !e.categories || e.categories.length === 0,
  );
  if (hasUncategorized) allCategories.push('Uncategorized');

  const filteredEvents =
    selectedCategories.size === 0
      ? events
      : events.filter((e) => {
          if (
            selectedCategories.has('Uncategorized') &&
            (!e.categories || e.categories.length === 0)
          )
            return true;
          return e.categories?.some((cat) => selectedCategories.has(cat));
        });

  let visibleEvents =
    hidePastEvents && isToday
      ? filteredEvents.filter((e) => new Date(e.end) > currentTime)
      : filteredEvents;
  if (hideCanceledEvents)
    visibleEvents = visibleEvents.filter(
      (e) => !e.subject.startsWith('Canceled:'),
    );

  const hasCanceledEvents = events.some((e) =>
    e.subject.startsWith('Canceled:'),
  );

  useEffect(() => {
    if (events.length > 0 && !selectedEventId) {
      const now = new Date();
      const activeEvent = events.find(
        (e) => !e.isAllDay && new Date(e.start) <= now && new Date(e.end) > now,
      );
      const upcomingEvent = events.find(
        (e) => !e.isAllDay && new Date(e.start) > now,
      );
      if (activeEvent || upcomingEvent) {
        const eventId = (activeEvent || upcomingEvent)!.meetingId;
        autoSelectEvent(eventId);
        setTimeout(() => {
          document
            .querySelector(`[data-event-id="${eventId}"]`)
            ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);
      } else {
        const fallback = events.find((e) => !e.isAllDay) || events[0];
        if (fallback) autoSelectEvent(fallback.meetingId);
        if (isToday) {
          setTimeout(() => {
            document
              .querySelector('.calendar-now-line')
              ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 100);
        }
      }
    }
  }, [events, selectedEventId, isToday, autoSelectEvent]);

  useEffect(() => {
    const fetchTodayEvents = async () => {
      const today = new Date();
      const cacheKey = `enterprise-calendar-${formatLocalDate(today)}`;
      const cached = getFromCache<CalendarEvent[]>(cacheKey);
      if (cached) {
        setTodayEvents(cached);
        return;
      }
      try {
        const evts = await calendarProvider.getEvents(today);
        const mapped = (evts as any[]).map((e) => ({
          meetingId: e.id,
          meetingChangeKey: e.changeKey || '',
          subject: e.subject,
          start:
            typeof e.start === 'string'
              ? e.start
              : (e.start as Date).toISOString(),
          end:
            typeof e.end === 'string' ? e.end : (e.end as Date).toISOString(),
          location: e.location || '',
          organizer: e.organizer || '',
          status: e.status,
          isCanceled: e.isCancelled || false,
          categories: e.categories || [],
          isAllDay: e.isAllDay || false,
        }));
        setTodayEvents(mapped);
        setCache(cacheKey, mapped);
      } catch (err) {
        log('Failed to fetch today events:', err);
      }
    };
    const timeout = setTimeout(fetchTodayEvents, 100);
    const interval = setInterval(fetchTodayEvents, 5 * 60 * 1000);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [formatLocalDate]);

  const fetchMeetingDetails = async (meetingId: string) => {
    const event = events.find((e) => e.meetingId === meetingId);
    if (!event?.meetingChangeKey) return;
    const cacheKey = getCacheKey('sfdc', `details-${meetingId}`);
    const cached = getFromCache<MeetingDetails>(cacheKey);
    if (cached) {
      setMeetingDetails(cached);
      return;
    }
    setLoadingDetails(true);
    try {
      const vm = await calendarProvider.getMeetingDetails(
        meetingId,
        event.meetingChangeKey,
      );
      const details: MeetingDetails = {
        meetingId: (vm as any).id,
        meetingChangeKey: (vm as any).changeKey || '',
        subject: vm.subject,
        body: vm.body || '',
        attendees: ((vm as any).attendees || []).map((a: any) => ({
          email: a.email,
          name: a.name,
          status:
            a.status === 'none'
              ? 'No Response'
              : a.status === 'accepted'
                ? 'Accepted'
                : a.status === 'declined'
                  ? 'Declined'
                  : a.status,
        })),
        start:
          vm.start instanceof Date
            ? vm.start.toISOString()
            : (vm.start as string),
        end: vm.end instanceof Date ? vm.end.toISOString() : (vm.end as string),
        location: vm.location || '',
        organizer: vm.organizer || '',
        responseStatus: (vm as any).responseStatus || 'No Response',
      };
      details.attendees?.forEach((a) => {
        if (a.email && a.name) addEmailName(a.email, a.name);
      });
      if (details.attendees) {
        details.attendees = details.attendees.map((a) => ({
          ...a,
          name: a.name || getNameForEmail(a.email),
        }));
      }
      setMeetingDetails(details);
      setCache(cacheKey, details);
    } catch (err) {
      log('Failed to fetch meeting details:', err);
    } finally {
      setLoadingDetails(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: fetchMeetingDetails recreated each render; omitting avoids infinite loop
  useEffect(() => {
    if (selectedEventId && events.length > 0) {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      fetchMeetingDetails(selectedEventId);
      if (isUserSelected) {
        setTimeout(() => {
          document
            .querySelector(`[data-event-id="${selectedEventId}"]`)
            ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);
      }
    }
  }, [selectedEventId, events.length, isUserSelected]);

  useEffect(() => {
    const nowLine = document.querySelector('.calendar-now-line');
    if (!nowLine) {
      setIsNowLineVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsNowLineVisible(entry.isIntersecting);
      },
      { threshold: 0.1 },
    );
    observer.observe(nowLine);
    return () => observer.disconnect();
  }, []);

  const _handleRefresh = () => {
    Object.keys(sessionStorage).forEach((key) => {
      if (
        key.startsWith('enterprise-calendar-') ||
        key.startsWith('enterprise-sfdc-')
      )
        sessionStorage.removeItem(key);
    });
    window.location.reload();
  };

  const fetchSFDCContext = async (loadAllAccounts = false) => {
    if (!selectedEvent) return;
    setLoadingSFDC(true);
    try {
      let matchedAccounts: any[] = [];
      let suggestedKeyword = '';
      if (loadAllAccounts) {
        matchedAccounts =
          salesContext?.myAccounts?.map((atm: any) => atm.account || atm) || [];
      } else {
        const meetingContext =
          `Meeting: ${selectedEvent.subject}\nOrganizer: ${selectedEvent.organizer || 'Unknown'}\nAttendees: ${meetingDetails?.attendees?.map((a) => a.email).join(', ') || 'None'}\nCategories: ${selectedEvent.categories?.join(', ') || 'None'}`.trim();
        const myAccountsList =
          salesContext?.myAccounts
            ?.map((atm: any) => {
              const acc = atm.account || atm;
              return `${acc.name} (${acc.id})`;
            })
            .join('\n') || '';
        const analysisResult = await invoke({
          prompt: `Analyze this meeting and match it to customer accounts:\n\n${meetingContext}\n\nMy assigned accounts:\n${myAccountsList}\n\nTasks:\n1. Match meeting to accounts ONLY if there is clear evidence in the meeting subject, attendee emails, or categories. Return ONLY accounts with strong evidence of relevance.\n2. Extract ONE keyword from meeting subject for opportunity search. Return exactly ONE word or compound word. If none, return empty string.\n\nReturn matched accounts and single keyword.`,
          schema: {
            type: 'object',
            properties: {
              matchedAccounts: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    id: { type: 'string' },
                  },
                  required: ['name', 'id'],
                },
              },
              keyword: { type: 'string' },
            },
            required: ['matchedAccounts', 'keyword'],
          },
          maxSteps: 1,
          model: 'us.amazon.nova-lite-v1:0',
        });
        const matchedFromLLM = (analysisResult as any).matchedAccounts || [];
        suggestedKeyword = (analysisResult as any).keyword || '';
        matchedAccounts =
          salesContext?.myAccounts
            ?.filter((atm: any) => {
              const acc = atm.account || atm;
              return matchedFromLLM.some((ma: any) => ma.id === acc.id);
            })
            .map((atm: any) => atm.account || atm) || [];
      }
      const context: SFDCContext = {
        accounts: matchedAccounts,
        opportunities: [],
        tasks: [],
        suggestedKeyword,
      };
      setSfdcContext(context);
      if (matchedAccounts.length > 0) {
        const firstAccount = matchedAccounts[0];
        const item = { type: 'account' as const, data: firstAccount };
        setSelectedSfdcItem(item);
        fetchTasksForItem(item);
        prefillActivityData(item);
        fetchOpportunitiesForAccount(firstAccount.id, '');
      }
    } catch (err) {
      log('Failed to fetch SFDC context:', err);
      setSfdcContext({ accounts: [], opportunities: [], tasks: [] });
    } finally {
      setLoadingSFDC(false);
    }
  };

  const fetchOpportunitiesForAccount = async (
    accountId: string,
    _keyword: string,
  ) => {
    try {
      const opps = await crmProvider.getAccountOpportunities(accountId);
      const opportunities = opps
        .map((opp: any) => ({
          id: opp.id,
          name: opp.name,
          accountId: opp.accountId,
          amount: opp.amount,
          closeDate:
            opp.closeDate instanceof Date
              ? opp.closeDate.toISOString().split('T')[0]
              : opp.closeDate,
          stageName: opp.stage || opp.stageName,
          probability: opp.probability,
          owner: opp.owner,
        }))
        .sort(
          (a: any, b: any) =>
            new Date(b.closeDate).getTime() - new Date(a.closeDate).getTime(),
        );
      setSfdcContext((prev) => ({
        ...prev,
        opportunities,
        selectedAccountId: accountId,
      }));
    } catch (err) {
      log('Failed to fetch opportunities:', err);
    }
  };

  const handleSelectSearchResult = (item: any) => {
    if (searchModalType === 'account') {
      setSfdcContext((prev) => {
        const exists = prev?.accounts?.some((a) => a.id === item.id);
        if (exists) return prev;
        return { ...prev, accounts: [...(prev?.accounts || []), item] };
      });
      const accountItem = { type: 'account' as const, data: item };
      setSelectedSfdcItem(accountItem);
      fetchTasksForItem(accountItem);
      prefillActivityData(accountItem);
      setLoadingOpportunities(true);
      fetchOpportunitiesForAccount(item.id, '').finally(() =>
        setLoadingOpportunities(false),
      );
    } else {
      setSfdcContext((prev) => {
        const exists = prev?.campaigns?.some((c) => c.id === item.id);
        if (exists) return prev;
        return { ...prev, campaigns: [...(prev?.campaigns || []), item] };
      });
      const campaignItem = { type: 'campaign' as const, data: item };
      setSelectedSfdcItem(campaignItem);
      fetchTasksForItem(campaignItem);
      prefillActivityData(campaignItem);
    }
    setShowSearchModal(false);
  };

  const fetchTasksForItem = async (item: {
    type: 'account' | 'opportunity' | 'campaign';
    data: any;
  }) => {
    setLoadingTasks(true);
    try {
      const filters: {
        accountId?: string;
        opportunityId?: string;
        limit: number;
      } = { limit: 25 };
      if (item.type === 'opportunity') filters.opportunityId = item.data.id;
      else if (item.type === 'account') filters.accountId = item.data.id;
      const userId = salesContext.myDetails?.id;
      if (!userId) {
        log('No user ID available for task fetch');
        return;
      }
      const result = await crmProvider.getUserTasks(userId, filters);
      const mappedTasks = result.tasks.map((t: any) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        activityDate:
          t.dueDate instanceof Date
            ? t.dueDate.toISOString().split('T')[0]
            : t.dueDate,
        description: t.description,
        priority: t.priority,
        activityType: t.activityType,
        what: t.relatedTo
          ? { __typename: t.relatedTo.type, name: t.relatedTo.name }
          : undefined,
        whatId: t.relatedTo?.id,
      }));
      setSfdcContext((prev) => ({ ...prev, tasks: mappedTasks }));
      setTasksCursor(
        (result as any).hasNextPage ? (result as any).cursor : undefined,
      );
    } catch (err) {
      log('Failed to fetch tasks:', err);
    } finally {
      setLoadingTasks(false);
    }
  };

  const prefillActivityData = async (item: {
    type: 'account' | 'opportunity' | 'campaign';
    data: any;
  }) => {
    if (!selectedEvent || !meetingDetails) return;
    setLoadingActivityPrefill(true);
    try {
      const meetingInfo = `Meeting: ${selectedEvent.subject}\nTime: ${new Date(selectedEvent.start).toLocaleString()}\nAttendees: ${meetingDetails.attendees?.map((a) => a.email).join(', ') || 'None'}`;
      const meetingBody = meetingDetails.body
        ? `\nMeeting Notes:\n${meetingDetails.body.replace(/<[^>]*>/g, '').trim()}`
        : '';
      const response = await invoke({
        prompt: `Generate a tech activity log for ${item.type}: ${item.data.name}\n\nCRITICAL RULES:\n1. For the description field, use this format:\n\nAttendees:\n[List ONLY the attendees provided below]\n\nOverview:\n[Summarize based ONLY on the meeting body content provided. If no meeting body, write "No meeting notes available."]\n\n2. EXCLUDE ALL meeting logistics (video links, dial-in numbers, room details).\n3. ONLY use information explicitly provided below.\n\n---\nMEETING INFORMATION PROVIDED:\n${meetingInfo}${meetingBody}`,
        schema: {
          type: 'object',
          properties: {
            activityType: {
              type: 'string',
              enum: [
                'Architecture Review',
                'Cloud Adoption Framework',
                'Demo',
                'Foundational Technical Review',
                'Migration Readiness Assessment',
                'Migration/Modernization Acceleration',
                'Other Architecture Advice',
                'Prototype/PoC/Pilot',
                'Security, Resilience and Compliance',
                'Well Architected',
                'Account Planning',
                'Cost Optimization',
                'Meeting / Office Hours',
                'RFI and RFP response',
                'Support/Escalation',
                'Activation Day',
                'GameDay',
                'Hackathon',
                'Immersion Day',
                'Other Workshops',
                'CCoE',
                'EBA',
                'EBC',
                'MAP',
                'Other Program Execution',
              ],
            },
            description: { type: 'string' },
          },
          required: ['activityType', 'description'],
        },
        maxSteps: 1,
        model: 'us.amazon.nova-lite-v1:0',
      });
      const meetingDate = new Date(selectedEvent.start);
      const activityDate = `${meetingDate.getFullYear()}-${String(meetingDate.getMonth() + 1).padStart(2, '0')}-${String(meetingDate.getDate()).padStart(2, '0')}`;
      setActivityFormData({
        subject: selectedEvent.subject,
        activityType:
          (response as any).activityType || 'Meeting / Office Hours',
        activityDate,
        description: (response as any).description || '',
      });
    } catch (err) {
      log('Failed to prefill activity data:', err);
    } finally {
      setLoadingActivityPrefill(false);
    }
  };

  return (
    <div className="workspace-dashboard">
      {upcomingNotification && (
        <div className="cal-notification">
          <div className="cal-notification__header">
            <strong className="cal-notification__title">
              {upcomingNotification.minutesUntil === 1
                ? 'Meeting starting in 1 minute!'
                : `Meeting in ${upcomingNotification.minutesUntil} minutes`}
            </strong>
            <button
              type="button"
              onClick={() =>
                setDismissedNotifications((prev) =>
                  new Set(prev).add(upcomingNotification.notificationId),
                )
              }
              className="cal-notification__dismiss"
            >
              ×
            </button>
          </div>
          <div className="cal-notification__body">
            <button
              type="button"
              onClick={() => {
                setSelectedDate(new Date());
                setViewMonth(new Date());
                setTimeout(() => {
                  selectEvent(upcomingNotification.meeting.meetingId);
                  fetchMeetingDetails(upcomingNotification.meeting.meetingId);
                  setSfdcContext(null);
                }, 100);
              }}
              className="cal-notification__link"
            >
              {upcomingNotification.meeting.subject}
            </button>
          </div>
          <div className="cal-notification__meta">
            {new Date(upcomingNotification.meeting.start).toLocaleTimeString(
              'en-US',
              { hour: 'numeric', minute: '2-digit' },
            )}
          </div>
        </div>
      )}

      <div className="workspace-dashboard__content">
        <aside className="workspace-dashboard__calendar">
          <div className="cal-sidebar-sticky">
            <div
              className={`calendar-widget cal-widget ${calendarCollapsed ? 'cal-widget--collapsed' : 'cal-widget--expanded'}`}
            >
              <div className="cal-widget__nav">
                <button
                  type="button"
                  onClick={() =>
                    setViewMonth(
                      new Date(
                        viewMonth.getFullYear(),
                        viewMonth.getMonth() - 1,
                        1,
                      ),
                    )
                  }
                  className="cal-widget__nav-btn"
                >
                  ←
                </button>
                <strong className="cal-widget__month">
                  {viewMonth.toLocaleDateString('en-US', {
                    month: 'short',
                    year: 'numeric',
                  })}
                </strong>
                <button
                  type="button"
                  onClick={() =>
                    setViewMonth(
                      new Date(
                        viewMonth.getFullYear(),
                        viewMonth.getMonth() + 1,
                        1,
                      ),
                    )
                  }
                  className="cal-widget__nav-btn"
                >
                  →
                </button>
              </div>
              <div className="cal-widget__grid">
                {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, i) => (
                  <div key={i} className="cal-widget__day-header">
                    {day}
                  </div>
                ))}
                {(() => {
                  const year = viewMonth.getFullYear();
                  const month = viewMonth.getMonth();
                  const firstDay = new Date(year, month, 1).getDay();
                  const daysInMonth = new Date(year, month + 1, 0).getDate();
                  const today = new Date();
                  const days = [];
                  for (let i = 0; i < firstDay; i++)
                    days.push(<div key={`empty-${i}`} />);
                  for (let day = 1; day <= daysInMonth; day++) {
                    const date = new Date(year, month, day);
                    const isSelected =
                      date.toDateString() === selectedDate.toDateString();
                    const isTodayDate =
                      date.toDateString() === today.toDateString();
                    days.push(
                      <button
                        type="button"
                        key={day}
                        onClick={() => setSelectedDate(date)}
                        disabled={loading}
                        className={`cal-widget__day-btn ${isSelected ? 'cal-widget__day-btn--selected' : ''} ${isTodayDate && !isSelected ? 'cal-widget__day-btn--today' : ''} ${loading && !isSelected ? 'cal-widget__day-btn--loading' : ''}`}
                      >
                        {day}
                      </button>,
                    );
                  }
                  return days;
                })()}
              </div>
            </div>
            <div
              className="cal-collapse-row"
              style={{ marginTop: calendarCollapsed ? '0' : '0.5rem' }}
            >
              <button
                type="button"
                onClick={() => setCalendarCollapsed(!calendarCollapsed)}
                className="cal-collapse-btn"
                title={
                  calendarCollapsed ? 'Expand calendar' : 'Collapse calendar'
                }
              >
                <svg
                  aria-hidden="true"
                  className={`cal-collapse-icon ${calendarCollapsed ? 'cal-collapse-icon--collapsed' : 'cal-collapse-icon--expanded'}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>
            </div>
          </div>

          <h3 className="cal-events-header">
            <span className="cal-events-header__title">
              {loading && (
                <span className="workspace-dashboard__spinner workspace-dashboard__spinner--sm" />
              )}
              {loading
                ? 'Loading...'
                : isToday
                  ? "Today's Meetings"
                  : selectedDate.toLocaleDateString('en-US', {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                    })}
            </span>
            {selectedDate.toDateString() !== new Date().toDateString() ? (
              <button
                type="button"
                onClick={() => {
                  const t = new Date();
                  setSelectedDate(t);
                  setViewMonth(new Date(t.getFullYear(), t.getMonth(), 1));
                }}
                className="cal-btn--today"
              >
                Today
              </button>
            ) : isToday && events.length > 0 && !isNowLineVisible ? (
              <button
                type="button"
                onClick={() => {
                  document
                    .querySelector('.calendar-now-line')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }}
                className="cal-btn--today"
              >
                Now
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setEventModalData(undefined);
                setShowCreateEventModal(true);
              }}
              className="cal-btn--new"
              title="Create new event"
            >
              + New
            </button>
          </h3>

          {!loading &&
            allCategories.length > 0 &&
            !(
              allCategories.length === 1 && allCategories[0] === 'Uncategorized'
            ) && (
              <div className="cal-filter-wrap">
                <div className="cal-filter-header">
                  <div className="cal-filter-header__left">
                    <span>Filter</span>
                    {selectedCategories.size > 0 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedCategories(new Set());
                          setHideCanceledEvents(false);
                        }}
                        className="cal-filter-clear"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <div className="cal-filter-header__right">
                    {isToday && (
                      <button
                        type="button"
                        className={`cal-filter-toggle ${hidePastEvents ? 'cal-filter-toggle--active' : 'cal-filter-toggle--inactive'}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setHidePastEvents(!hidePastEvents);
                        }}
                      >
                        Hide past
                      </button>
                    )}
                    {hasCanceledEvents && (
                      <button
                        type="button"
                        className={`cal-filter-toggle ${hideCanceledEvents ? 'cal-filter-toggle--active' : 'cal-filter-toggle--inactive'}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setHideCanceledEvents(!hideCanceledEvents);
                        }}
                      >
                        Hide Canceled
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setFilterExpanded(!filterExpanded)}
                      aria-expanded={filterExpanded}
                      aria-controls="cal-filter-panel"
                      aria-label={
                        filterExpanded
                          ? 'Collapse filter section'
                          : 'Expand filter section'
                      }
                      style={{
                        background: 'transparent',
                        border: 'none',
                        padding: 0,
                        margin: 0,
                        font: 'inherit',
                        color: 'inherit',
                        cursor: 'pointer',
                      }}
                    >
                      {filterExpanded ? '▼' : '▶'}
                    </button>
                  </div>
                </div>
                {!filterExpanded && selectedCategories.size > 0 && (
                  <div className="cal-filter-selected-tags">
                    {Array.from(selectedCategories).map((cat) => (
                      <span key={cat} className="cal-filter-tag--selected">
                        {cat}
                      </span>
                    ))}
                  </div>
                )}
                {filterExpanded && (
                  <div id="cal-filter-panel">
                    <div className="cal-filter-buttons">
                      {allCategories.map((cat) => (
                        <button
                          type="button"
                          key={cat}
                          onClick={() => {
                            const s = new Set(selectedCategories);
                            if (s.has(cat)) s.delete(cat);
                            else s.add(cat);
                            setSelectedCategories(s);
                          }}
                          className={`cal-filter-btn ${selectedCategories.has(cat) ? 'cal-filter-btn--active' : 'cal-filter-btn--inactive'}`}
                        >
                          {cat}
                        </button>
                      ))}
                    </div>
                    {selectedCategories.size > 0 && (
                      <div className="cal-filter-count">
                        Showing {filteredEvents.length} of {events.length}{' '}
                        events
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

          {loading ? (
            <div className="cal-status-msg">
              <p>Loading events...</p>
            </div>
          ) : error ? (
            <div className="cal-error-msg">
              <p>{error}</p>
            </div>
          ) : filteredEvents.length === 0 ? (
            <div className="cal-status-msg">
              <p>
                {selectedCategories.size === 0
                  ? 'No events for this date'
                  : 'No events match selected categories'}
              </p>
            </div>
          ) : visibleEvents.length === 0 ? (
            isToday ? (
              <ul className="cal-empty-list">
                <div className="calendar-now-line cal-now-line-indicator">
                  Now -{' '}
                  {currentTime.toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </div>
                <div className="cal-no-more-events">
                  No more events for{' '}
                  {selectedDate.toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                  })}
                  ...
                </div>
              </ul>
            ) : (
              <div className="cal-status-msg">
                <p>No upcoming events</p>
              </div>
            )
          ) : (
            <>
              {visibleEvents.filter((e) => e.isAllDay).length > 0 && (
                <details
                  open={allDayExpanded}
                  onToggle={(e) =>
                    setAllDayExpanded((e.target as HTMLDetailsElement).open)
                  }
                  className="cal-allday-section"
                >
                  <summary className="cal-allday-summary">
                    All-Day Events (
                    {visibleEvents.filter((e) => e.isAllDay).length})
                  </summary>
                  <ul className="cal-allday-list">
                    {visibleEvents
                      .filter((e) => e.isAllDay)
                      .map((event) => (
                        <li
                          key={event.meetingId}
                          data-event-id={event.meetingId}
                          className={`workspace-dashboard__calendar-item ${event.meetingId === selectedEventId ? 'is-active' : ''}`}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              if (selectedEventId === event.meetingId) {
                                clearSelection();
                                setSfdcContext(null);
                                return;
                              }
                              selectEvent(event.meetingId);
                              fetchMeetingDetails(event.meetingId);
                              setSfdcContext(null);
                            }}
                          >
                            <span className="workspace-dashboard__title">
                              {event.subject}
                            </span>
                            {event.categories &&
                              event.categories.length > 0 && (
                                <div className="cal-event-categories">
                                  {event.categories.map((cat) => (
                                    <span
                                      key={cat}
                                      className="cal-event-category-badge"
                                    >
                                      {cat}
                                    </span>
                                  ))}
                                </div>
                              )}
                          </button>
                          <div className="cal-event-actions">
                            <button
                              type="button"
                              className="cal-event-action"
                              title="Edit event"
                              aria-label="Edit event"
                              onClick={async (e) => {
                                e.stopPropagation();
                                const s = new Date(event.start);
                                const en = new Date(event.end);
                                const ck = getCacheKey(
                                  'sfdc',
                                  `details-${event.meetingId}`,
                                );
                                let cached = getFromCache<MeetingDetails>(ck);
                                if (!cached && event.meetingChangeKey) {
                                  try {
                                    const vm =
                                      await calendarProvider.getMeetingDetails(
                                        event.meetingId,
                                        event.meetingChangeKey,
                                      );
                                    cached = {
                                      meetingId: (vm as any).id,
                                      meetingChangeKey:
                                        (vm as any).changeKey || '',
                                      subject: vm.subject,
                                      body: vm.body || '',
                                      attendees: (
                                        (vm as any).attendees || []
                                      ).map((a: any) => ({
                                        email: a.email,
                                        name: a.name,
                                        status: a.status,
                                      })),
                                      start:
                                        vm.start instanceof Date
                                          ? vm.start.toISOString()
                                          : (vm.start as string),
                                      end:
                                        vm.end instanceof Date
                                          ? vm.end.toISOString()
                                          : (vm.end as string),
                                      location: vm.location || '',
                                      organizer: vm.organizer || '',
                                    };
                                    setCache(ck, cached);
                                  } catch {
                                    /* ignore */
                                  }
                                }
                                setEventModalData({
                                  meetingId: event.meetingId,
                                  meetingChangeKey: event.meetingChangeKey,
                                  subject: event.subject,
                                  start: `${String(s.getHours()).padStart(2, '0')}:${String(s.getMinutes()).padStart(2, '0')}`,
                                  end: `${String(en.getHours()).padStart(2, '0')}:${String(en.getMinutes()).padStart(2, '0')}`,
                                  attendees: cached?.attendees?.map((a) => ({
                                    email: a.email,
                                    name: a.name,
                                  })),
                                  location: event.location,
                                  body: cached?.body,
                                });
                                setShowCreateEventModal(true);
                              }}
                            >
                              <svg
                                aria-hidden="true"
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                                <path d="m15 5 4 4" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              className="cal-event-action cal-event-action--danger"
                              title="Delete event"
                              aria-label="Delete event"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDeleteEvent(event);
                              }}
                            >
                              <svg
                                aria-hidden="true"
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="M18 6 6 18" />
                                <path d="m6 6 12 12" />
                              </svg>
                            </button>
                          </div>
                        </li>
                      ))}
                  </ul>
                </details>
              )}

              {visibleEvents.filter((e) => !e.isAllDay).length > 0 && (
                <div className="cal-events-count">
                  Events ({visibleEvents.filter((e) => !e.isAllDay).length})
                </div>
              )}

              <ul>
                {(() => {
                  const nonAllDayEvents = visibleEvents.filter(
                    (e) => !e.isAllDay,
                  );
                  const result: React.JSX.Element[] = [];
                  let activeGroup: React.JSX.Element[] = [];
                  let showedIndicator = false;

                  nonAllDayEvents.forEach((event, idx) => {
                    const eventStart = new Date(event.start);
                    const eventEnd = new Date(event.end);
                    const prevEvent = idx > 0 ? nonAllDayEvents[idx - 1] : null;
                    const prevEventEnd = prevEvent
                      ? new Date(prevEvent.end)
                      : null;
                    const isActiveEvent =
                      currentTime >= eventStart && currentTime < eventEnd;
                    const showTimeLineBefore =
                      isToday &&
                      !showedIndicator &&
                      ((idx === 0 && currentTime < eventStart) ||
                        (prevEventEnd !== null &&
                          currentTime > prevEventEnd &&
                          currentTime < eventStart) ||
                        isActiveEvent);

                    if (showTimeLineBefore) {
                      showedIndicator = true;
                      let indicatorText = '';
                      let nextMeetingLink: React.JSX.Element | null = null;
                      let joinButton: React.JSX.Element | null = null;

                      if (isActiveEvent) {
                        const meetingProvider = detectMeetingProvider(
                          event.location,
                          meetingDetails?.body,
                        );
                        indicatorText = `Now ${currentTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} - `;
                        nextMeetingLink = (
                          <button
                            type="button"
                            onClick={() => {
                              selectEvent(event.meetingId);
                              fetchMeetingDetails(event.meetingId);
                              setSfdcContext(null);
                            }}
                            className="cal-notification__link"
                          >
                            {event.subject}
                          </button>
                        );
                        if (meetingProvider) {
                          joinButton = (
                            <>
                              {' in progress • '}
                              <a
                                href={meetingProvider.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="cal-notification__join"
                              >
                                Join Now
                              </a>
                            </>
                          );
                        } else {
                          joinButton = <span> in progress</span>;
                        }
                      } else {
                        const allNonAllDay = events.filter((e) => !e.isAllDay);
                        const nextMeeting = allNonAllDay.find(
                          (e) => new Date(e.start) > currentTime,
                        );
                        if (nextMeeting) {
                          const minutesUntil = Math.round(
                            (new Date(nextMeeting.start).getTime() -
                              currentTime.getTime()) /
                              60000,
                          );
                          const hoursUntil = Math.floor(minutesUntil / 60);
                          const remainingMinutes = minutesUntil % 60;
                          const timeText =
                            hoursUntil > 0
                              ? `${hoursUntil}h ${remainingMinutes}m`
                              : `${minutesUntil}m`;
                          const isFiltered = !visibleEvents.some(
                            (e) => e.meetingId === nextMeeting.meetingId,
                          );
                          nextMeetingLink = (
                            <button
                              type="button"
                              onClick={() => {
                                if (isFiltered) {
                                  setSelectedCategories(new Set());
                                  setHidePastEvents(false);
                                  setHideCanceledEvents(false);
                                }
                                selectEvent(nextMeeting.meetingId);
                                fetchMeetingDetails(nextMeeting.meetingId);
                                setSfdcContext(null);
                              }}
                              className="cal-notification__link"
                            >
                              {nextMeeting.subject}
                            </button>
                          );
                          indicatorText = `Now ${currentTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} - ${timeText} until next meeting: `;
                        } else {
                          indicatorText = `Now - ${currentTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
                        }
                      }
                      result.push(
                        <div
                          key={`indicator-${event.meetingId}`}
                          className="calendar-now-line cal-now-line-indicator"
                        >
                          {indicatorText}
                          {nextMeetingLink}
                          {joinButton}
                        </div>,
                      );
                    }

                    const isSelected = event.meetingId === selectedEventId;
                    const eventItem = (
                      <li
                        key={event.meetingId}
                        data-event-id={event.meetingId}
                        className={`workspace-dashboard__calendar-item ${isSelected ? 'is-active' : ''} ${isActiveEvent ? 'cal-event--active' : ''}`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            if (isSelected) {
                              clearSelection();
                              setSfdcContext(null);
                              return;
                            }
                            selectEvent(event.meetingId);
                            fetchMeetingDetails(event.meetingId);
                            setSfdcContext(null);
                          }}
                          className={
                            isSelected ? 'cal-event-btn--selected' : undefined
                          }
                        >
                          <span className="workspace-dashboard__time">
                            {new Date(event.start).toLocaleTimeString('en-US', {
                              hour: 'numeric',
                              minute: '2-digit',
                            })}
                            {' - '}
                            {new Date(event.end).toLocaleTimeString('en-US', {
                              hour: 'numeric',
                              minute: '2-digit',
                            })}
                          </span>
                          <span className="workspace-dashboard__title">
                            {event.subject}
                          </span>
                          {event.categories && event.categories.length > 0 && (
                            <div className="cal-event-categories">
                              {event.categories.map((cat) => (
                                <span
                                  key={cat}
                                  className="cal-event-category-badge"
                                >
                                  {cat}
                                </span>
                              ))}
                            </div>
                          )}
                        </button>
                        <div className="cal-event-actions">
                          <button
                            type="button"
                            className="cal-event-action"
                            title="Edit event"
                            aria-label="Edit event"
                            onClick={async (e) => {
                              e.stopPropagation();
                              const s = new Date(event.start);
                              const en = new Date(event.end);
                              const ck = getCacheKey(
                                'sfdc',
                                `details-${event.meetingId}`,
                              );
                              let cached = getFromCache<MeetingDetails>(ck);
                              if (!cached && event.meetingChangeKey) {
                                try {
                                  const vm =
                                    await calendarProvider.getMeetingDetails(
                                      event.meetingId,
                                      event.meetingChangeKey,
                                    );
                                  cached = {
                                    meetingId: (vm as any).id,
                                    meetingChangeKey:
                                      (vm as any).changeKey || '',
                                    subject: vm.subject,
                                    body: vm.body || '',
                                    attendees: (
                                      (vm as any).attendees || []
                                    ).map((a: any) => ({
                                      email: a.email,
                                      name: a.name,
                                      status: a.status,
                                    })),
                                    start:
                                      vm.start instanceof Date
                                        ? vm.start.toISOString()
                                        : (vm.start as string),
                                    end:
                                      vm.end instanceof Date
                                        ? vm.end.toISOString()
                                        : (vm.end as string),
                                    location: vm.location || '',
                                    organizer: vm.organizer || '',
                                  };
                                  setCache(ck, cached);
                                } catch {
                                  /* ignore */
                                }
                              }
                              setEventModalData({
                                meetingId: event.meetingId,
                                meetingChangeKey: event.meetingChangeKey,
                                subject: event.subject,
                                start: `${String(s.getHours()).padStart(2, '0')}:${String(s.getMinutes()).padStart(2, '0')}`,
                                end: `${String(en.getHours()).padStart(2, '0')}:${String(en.getMinutes()).padStart(2, '0')}`,
                                attendees: cached?.attendees?.map((a) => ({
                                  email: a.email,
                                  name: a.name,
                                })),
                                location: event.location,
                                body: cached?.body,
                              });
                              setShowCreateEventModal(true);
                            }}
                          >
                            <svg
                              aria-hidden="true"
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                              <path d="m15 5 4 4" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="cal-event-action cal-event-action--danger"
                            title="Delete event"
                            aria-label="Delete event"
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteEvent(event);
                            }}
                          >
                            <svg
                              aria-hidden="true"
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M18 6 6 18" />
                              <path d="m6 6 12 12" />
                            </svg>
                          </button>
                        </div>
                      </li>
                    );

                    if (isActiveEvent) {
                      activeGroup.push(eventItem);
                    } else {
                      if (activeGroup.length > 0) {
                        result.push(
                          <div
                            key={`active-group-${activeGroup[0].key}`}
                            className="active-events-group cal-active-group"
                          >
                            {activeGroup}
                          </div>,
                        );
                        activeGroup = [];
                      }
                      result.push(eventItem);
                    }
                  });

                  if (activeGroup.length > 0) {
                    result.push(
                      <div
                        key="active-group-final"
                        className="active-events-group cal-active-group"
                      >
                        {activeGroup}
                      </div>,
                    );
                  }
                  return result;
                })()}
                {isToday &&
                  visibleEvents.filter((e) => !e.isAllDay).length > 0 &&
                  currentTime >
                    new Date(
                      visibleEvents.filter((e) => !e.isAllDay)[
                        visibleEvents.filter((e) => !e.isAllDay).length - 1
                      ].end,
                    ) && (
                    <>
                      <div className="calendar-now-line cal-now-line-indicator">
                        Now -{' '}
                        {currentTime.toLocaleTimeString('en-US', {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </div>
                      <div className="cal-no-more-events">
                        No more events for{' '}
                        {selectedDate.toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                        })}
                        ...
                      </div>
                    </>
                  )}
              </ul>
            </>
          )}
        </aside>

        <section className="workspace-dashboard__details">
          {selectedEvent &&
            (() => {
              const meetingProvider = detectMeetingProvider(
                meetingDetails?.location,
                meetingDetails?.body,
              );
              return (
                <div className="workspace-dashboard__card">
                  <div className="cal-detail-layout">
                    <div className="cal-detail-header">
                      <div className="cal-detail-title-wrap">
                        <h3 className="cal-detail-title">
                          {selectedEvent.subject}
                        </h3>
                        {selectedEvent.categories &&
                          selectedEvent.categories.length > 0 && (
                            <div className="cal-detail-categories">
                              {selectedEvent.categories.map((cat) => (
                                <span
                                  key={cat}
                                  className="cal-detail-category-badge"
                                >
                                  {cat}
                                </span>
                              ))}
                            </div>
                          )}
                      </div>
                      <div className="cal-detail-actions">
                        <button
                          type="button"
                          onClick={() => {
                            fetchSFDCContext();
                            setShowLogActivityModal(true);
                          }}
                          disabled={loadingSFDC}
                          className={`cal-detail-btn ${loadingSFDC ? 'cal-detail-btn--disabled' : ''}`}
                        >
                          {loadingSFDC ? 'Loading...' : 'Log Activity'}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setMeetingNotes((prev) =>
                              prev !== null
                                ? null
                                : localStorage.getItem(
                                    `meeting-notes:${selectedEventId}`,
                                  ) || '',
                            )
                          }
                          className={`cal-detail-btn ${meetingNotes !== null ? 'cal-detail-btn--active' : ''}`}
                        >
                          Take Notes
                        </button>
                        {meetingDetails && (
                          <button
                            type="button"
                            onClick={() => {
                              setEventModalData({
                                subject: meetingDetails.subject,
                                attendees: meetingDetails.attendees?.map(
                                  (a) => ({ email: a.email, name: a.name }),
                                ),
                                location: meetingDetails.location,
                              });
                              setShowCreateEventModal(true);
                            }}
                            className="cal-detail-btn"
                            title="Schedule a follow-up with same attendees"
                          >
                            Schedule Follow-up
                          </button>
                        )}
                        {meetingDetails && (
                          <button
                            type="button"
                            onClick={() => {
                              const meetingInfo = `Meeting: ${meetingDetails.subject}\nTime: ${new Date(meetingDetails.start).toLocaleString()} - ${new Date(meetingDetails.end).toLocaleTimeString()}\nLocation: ${meetingDetails.location || 'Not specified'}${meetingDetails.attendees ? `\nAttendees: ${meetingDetails.attendees.map((a) => a.email).join(', ')}` : ''}`;
                              sendToChat(
                                `I need to log an activity for this meeting:\n\n${meetingInfo}\n\nWorkflow:\n- Search my email for meeting notes or follow-ups related to "${meetingDetails.subject}"\n- Use the attendee list and meeting subject to identify the relevant CRM account\n- Find any related opportunities for this account\n- Present matching accounts/opportunities as a numbered list for me to choose from\n- Help me create the activity log with the meeting notes and context`,
                              );
                            }}
                            className="cal-detail-btn cal-detail-btn--icon"
                            title="Ask agent for help"
                            aria-label="Ask agent for help"
                          >
                            <svg
                              aria-hidden="true"
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>
                    {selectedEvent &&
                      salesState?.loggedActivities?.[
                        selectedEvent.meetingId
                      ] && (
                        <div className="cal-activity-logged">
                          <div className="cal-activity-logged__title">
                            ✓ Activity Logged
                          </div>
                          <a
                            href={`${CRM_BASE_URL}/r/Task/${salesState.loggedActivities[selectedEvent.meetingId].id}/view`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="cal-activity-logged__link"
                          >
                            {
                              salesState.loggedActivities[
                                selectedEvent.meetingId
                              ].subject
                            }
                          </a>
                        </div>
                      )}
                    <div>
                      {meetingDetails?.organizer && (
                        <div className="cal-organizer-row">
                          <span>
                            Organized by{' '}
                            <a
                              href={`mailto:${meetingDetails.organizer}`}
                              className="cal-organizer-link"
                            >
                              {meetingDetails.organizer}
                            </a>
                          </span>
                          {meetingProvider && (
                            <a
                              href={meetingProvider.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="cal-join-btn"
                            >
                              Join {meetingProvider.provider} →
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {loadingDetails ? (
                    <p>Loading meeting details...</p>
                  ) : meetingDetails ? (
                    <>
                      <div>
                        <p>
                          <strong>Time:</strong>{' '}
                          {new Date(meetingDetails.start).toLocaleString()} -{' '}
                          {new Date(meetingDetails.end).toLocaleTimeString()}
                        </p>
                        <div className="cal-rsvp-row">
                          {(['accept', 'tentative', 'decline'] as const).map(
                            (resp) => {
                              const current = (
                                meetingDetails.responseStatus || ''
                              ).toLowerCase();
                              const isActive =
                                (resp === 'accept' && current === 'accepted') ||
                                (resp === 'tentative' &&
                                  (current === 'tentativelyaccepted' ||
                                    current === 'tentative')) ||
                                (resp === 'decline' && current === 'declined');
                              return (
                                <button
                                  type="button"
                                  key={resp}
                                  onClick={async () => {
                                    try {
                                      await transformTool(
                                        'enterprise-assistant',
                                        'calendar-mcp_calendar_meeting',
                                        {
                                          operation: 'update',
                                          meetingId:
                                            meetingDetails.meetingId ||
                                            selectedEventId,
                                          meetingChangeKey:
                                            meetingDetails.meetingChangeKey,
                                          rsvpResponse: resp,
                                        },
                                        'data => data',
                                      );
                                      showToast(`Meeting ${resp}ed`, 'success');
                                      meetingDetails.responseStatus =
                                        resp === 'accept'
                                          ? 'Accepted'
                                          : resp === 'decline'
                                            ? 'Declined'
                                            : 'TentativelyAccepted';
                                    } catch (e: unknown) {
                                      showToast(
                                        `Failed: ${(e as Error).message}`,
                                        'error',
                                      );
                                    }
                                  }}
                                  className={`cal-rsvp-btn ${isActive ? 'cal-rsvp-btn--active' : 'cal-rsvp-btn--inactive'}`}
                                >
                                  {resp === 'accept'
                                    ? '✓ Accept'
                                    : resp === 'decline'
                                      ? '✗ Decline'
                                      : '~ Tentative'}
                                </button>
                              );
                            },
                          )}
                        </div>

                        {meetingDetails.attendees &&
                          meetingDetails.attendees.length > 0 && (
                            <div>
                              <strong>
                                Attendees ({meetingDetails.attendees.length}):
                              </strong>
                              <ul className="cal-attendees-list">
                                {(showAllAttendees
                                  ? meetingDetails.attendees
                                  : meetingDetails.attendees.slice(0, 5)
                                ).map((a, i) => (
                                  <li key={i}>
                                    <a
                                      href={`mailto:${a.email}`}
                                      className="cal-attendee-link"
                                    >
                                      {a.name || a.email}
                                    </a>
                                    <span
                                      className={`attendee-status attendee-status--${a.status.toLowerCase().replace(' ', '-')} cal-attendee-status`}
                                    >
                                      ({a.status})
                                    </span>
                                  </li>
                                ))}
                              </ul>
                              {meetingDetails.attendees.length > 5 && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setShowAllAttendees(!showAllAttendees)
                                  }
                                  className="cal-show-more-btn"
                                >
                                  {showAllAttendees
                                    ? 'Show less'
                                    : `Show ${meetingDetails.attendees.length - 5} more`}
                                </button>
                              )}
                            </div>
                          )}

                        {meetingDetails.isCanceled && (
                          <p className="cal-canceled-text">
                            <strong>⚠️ Canceled</strong>
                          </p>
                        )}

                        {meetingDetails.body?.replace(/<[^>]*>/g, '').trim() ? (
                          <div className="cal-content-section">
                            <div className="cal-content-label">
                              <strong>Content:</strong>
                            </div>
                            <div className="cal-content-wrap">
                              <div
                                className={`meeting-body-content cal-content-body ${!contentExpanded ? 'cal-content-body--collapsed' : ''}`}
                                dangerouslySetInnerHTML={{
                                  __html: DOMPurify.sanitize(
                                    meetingDetails.body,
                                    {
                                      FORBID_ATTR: [
                                        'style',
                                        'bgcolor',
                                        'background',
                                        'color',
                                      ],
                                      FORBID_TAGS: ['style'],
                                      HOOKS: {
                                        afterSanitizeAttributes: (node) => {
                                          if (node.tagName === 'IMG') {
                                            const src =
                                              node.getAttribute('src');
                                            if (
                                              src?.startsWith('cid:') ||
                                              src?.includes('GetFileAttachment')
                                            )
                                              node.remove();
                                          }
                                        },
                                      },
                                    },
                                  ),
                                }}
                              />
                              {!contentExpanded && (
                                <div className="cal-content-fade">
                                  <button
                                    type="button"
                                    onClick={() => setContentExpanded(true)}
                                    className="cal-content-toggle"
                                  >
                                    Show more
                                  </button>
                                </div>
                              )}
                              {contentExpanded && (
                                <div className="cal-content-toggle-wrap">
                                  <button
                                    type="button"
                                    onClick={() => setContentExpanded(false)}
                                    className="cal-content-toggle"
                                  >
                                    Show less
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        ) : (
                          <div className="cal-no-content">
                            <p>No content to show.</p>
                          </div>
                        )}
                      </div>

                      {meetingNotes !== null && (
                        <div className="cal-notes-section">
                          <textarea
                            value={meetingNotes}
                            onChange={(e) => {
                              const val = e.target.value;
                              setMeetingNotes(val);
                              if (selectedEventId) {
                                if (val)
                                  localStorage.setItem(
                                    `meeting-notes:${selectedEventId}`,
                                    val,
                                  );
                                else
                                  localStorage.removeItem(
                                    `meeting-notes:${selectedEventId}`,
                                  );
                              }
                            }}
                            placeholder="Meeting notes... (auto-saved)"
                            className="cal-notes-textarea"
                          />
                          <div className="cal-notes-actions">
                            <button
                              type="button"
                              disabled={!meetingNotes.trim() || aiLoading}
                              onClick={async () => {
                                setAiLoading(true);
                                try {
                                  const context = `Meeting: ${meetingDetails.subject}\nDate: ${new Date(meetingDetails.start).toLocaleString()}\nAttendees: ${meetingDetails.attendees?.map((a) => a.name || a.email).join(', ') || 'None'}\n\nRaw notes:\n${meetingNotes}`;
                                  const r = await invoke(
                                    'enterprise-assistant',
                                    `Clean up and enhance these meeting notes. Keep the original meaning but improve structure, fix typos, and add any useful formatting. Return ONLY the improved notes, no preamble:\n\n${context}`,
                                  );
                                  const text =
                                    typeof r === 'string'
                                      ? r
                                      : (r as any)?.text ||
                                        (r as any)?.content ||
                                        JSON.stringify(r);
                                  setAiDraft(text);
                                } catch (e: any) {
                                  showToast(
                                    `AI enhance failed: ${e.message}`,
                                    'error',
                                  );
                                } finally {
                                  setAiLoading(false);
                                }
                              }}
                              className={`cal-notes-btn ${!meetingNotes.trim() || aiLoading ? 'cal-notes-btn--disabled' : ''}`}
                            >
                              {aiLoading
                                ? 'Enhancing...'
                                : '✨ Enhance with AI'}
                            </button>
                            <button
                              type="button"
                              disabled={!meetingNotes.trim()}
                              onClick={async () => {
                                const context = `# ${meetingDetails.subject}\n**Date:** ${new Date(meetingDetails.start).toLocaleString()}\n**Attendees:** ${meetingDetails.attendees?.map((a) => a.name || a.email).join(', ') || 'None'}\n\n## Notes\n${meetingNotes}`;
                                try {
                                  await navigator.clipboard.writeText(context);
                                  showToast(
                                    'Notes copied to clipboard',
                                    'success',
                                  );
                                } catch {
                                  showToast('Failed to copy notes', 'error');
                                }
                              }}
                              className={`cal-notes-btn ${!meetingNotes.trim() ? 'cal-notes-btn--disabled' : ''}`}
                            >
                              📋 Copy
                            </button>
                            <button
                              type="button"
                              disabled={
                                !meetingNotes.trim() ||
                                savedEventIds.has(selectedEventId!)
                              }
                              onClick={async () => {
                                if (savedEventIds.has(selectedEventId!)) {
                                  showToast(
                                    'Notes already saved for this event',
                                    'info',
                                  );
                                  return;
                                }
                                try {
                                  const filename = `${new Date(meetingDetails.start).toISOString().split('T')[0]}-${meetingDetails.subject
                                    .replace(/[^a-zA-Z0-9 ]/g, '')
                                    .replace(/\s+/g, '-')
                                    .toLowerCase()
                                    .slice(0, 40)}.md`;
                                  const content = `# ${meetingDetails.subject}\n\n**Date:** ${new Date(meetingDetails.start).toLocaleString()}\n**Attendees:** ${meetingDetails.attendees?.map((a) => a.name || a.email).join(', ') || 'None'}\n\n## Notes\n${meetingNotes}`;
                                  const result = await notesSave.mutateAsync({
                                    filename,
                                    content,
                                    metadata: {
                                      eventId: selectedEventId,
                                      eventSubject: meetingDetails.subject,
                                      status: 'raw',
                                    },
                                  });
                                  const diskPath = (result as any)?.storagePath;
                                  const actions: any[] = [
                                    {
                                      label: 'View',
                                      variant: 'primary',
                                      onClick: () => {
                                        document
                                          .querySelectorAll(
                                            '.workspace-tabs__tab',
                                          )
                                          .forEach((t) => {
                                            if (
                                              t.textContent?.includes('Notes')
                                            )
                                              (t as HTMLElement).click();
                                          });
                                      },
                                    },
                                  ];
                                  if (diskPath)
                                    actions.push({
                                      label: 'Open in Obsidian',
                                      variant: 'secondary',
                                      onClick: () => {
                                        window.open(
                                          `obsidian://open?path=${encodeURIComponent(diskPath)}`,
                                        );
                                      },
                                    });
                                  showToast(
                                    diskPath
                                      ? `Saved → ${diskPath}`
                                      : 'Notes saved to knowledge base',
                                    undefined,
                                    8000,
                                    actions,
                                  );
                                  setSavedEventIds((prev) =>
                                    new Set(prev).add(selectedEventId!),
                                  );
                                } catch (e: any) {
                                  showToast(
                                    `Save failed: ${e.message}`,
                                    'error',
                                  );
                                }
                              }}
                              className={`cal-notes-btn ${!meetingNotes.trim() || savedEventIds.has(selectedEventId!) ? 'cal-notes-btn--disabled' : ''}`}
                            >
                              {savedEventIds.has(selectedEventId!)
                                ? '✓ Saved'
                                : '💾 Save to Notes'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setMeetingNotes(null)}
                              className="cal-notes-btn cal-notes-btn--close"
                            >
                              Close
                            </button>
                          </div>
                          {aiDraft && (
                            <div className="cal-ai-draft">
                              <div className="cal-ai-draft__header">
                                ✨ AI Enhanced Notes
                              </div>
                              <pre className="cal-ai-draft__content">
                                {aiDraft}
                              </pre>
                              <div className="cal-ai-draft__actions">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setMeetingNotes(aiDraft);
                                    if (selectedEventId)
                                      localStorage.setItem(
                                        `meeting-notes:${selectedEventId}`,
                                        aiDraft,
                                      );
                                    setAiDraft(null);
                                    showToast(
                                      'Notes replaced with AI version',
                                      'success',
                                    );
                                  }}
                                  className="cal-ai-draft__accept"
                                >
                                  Accept
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setAiDraft(null)}
                                  className="cal-ai-draft__dismiss"
                                >
                                  Dismiss
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="cal-select-event-msg">
                      <p>Select an event to view details</p>
                    </div>
                  )}
                </div>
              );
            })()}
        </section>
      </div>

      {/* Activity Detail Modal */}
      {showActivityDetailModal && (
        <div className="cal-modal-overlay cal-modal-overlay--z1002">
          <div className="cal-modal-container cal-activity-detail-modal">
            <div className="cal-modal-header">
              <h3 className="cal-modal-title">Activity Details</h3>
              <div className="cal-activity-detail__header-actions">
                <button
                  type="button"
                  onClick={() => {
                    setActivityToAssign(selectedActivity);
                    setShowAssignOppModal(true);
                    setOppFilterText('');
                  }}
                  className="cal-activity-detail__assign-btn"
                >
                  Assign To...
                </button>
                {selectedActivity?.id && (
                  <a
                    href={`${CRM_BASE_URL}/r/Task/${selectedActivity.id}/view`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="cal-activity-detail__sfdc-link"
                    title="Open in CRM"
                  >
                    ↗
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setShowActivityDetailModal(false);
                    setSelectedActivity(null);
                  }}
                  className="cal-modal-close"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="cal-modal-body">
              {loadingActivityDetails ? (
                <div className="cal-activity-detail__loading">
                  Loading details...
                </div>
              ) : selectedActivity ? (
                <div className="cal-activity-detail__fields">
                  <div>
                    <div className="cal-activity-detail__field-label">
                      Subject
                    </div>
                    <div className="cal-activity-detail__field-value--bold">
                      {selectedActivity.subject}
                    </div>
                  </div>
                  {selectedActivity.activityType && (
                    <div>
                      <div className="cal-activity-detail__field-label">
                        Activity Type
                      </div>
                      <div>{selectedActivity.activityType}</div>
                    </div>
                  )}
                  {selectedActivity.what?.name && (
                    <div>
                      <div className="cal-activity-detail__field-label">
                        Related To
                      </div>
                      <div>{selectedActivity.what.name}</div>
                    </div>
                  )}
                  {selectedActivity.activityDate && (
                    <div>
                      <div className="cal-activity-detail__field-label">
                        Activity Date
                      </div>
                      <div>{selectedActivity.activityDate}</div>
                    </div>
                  )}
                  {selectedActivity.status && (
                    <div>
                      <div className="cal-activity-detail__field-label">
                        Status
                      </div>
                      <div>{selectedActivity.status}</div>
                    </div>
                  )}
                  {selectedActivity.description && (
                    <div>
                      <div className="cal-activity-detail__field-label">
                        Description
                      </div>
                      <div className="cal-activity-detail__field-value--pre">
                        {selectedActivity.description}
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* Assign to Opportunity Modal */}
      {showAssignOppModal && activityToAssign && sfdcContext && (
        <div className="cal-modal-overlay cal-modal-overlay--z1002">
          <div className="cal-modal-container cal-assign-modal">
            <div className="cal-modal-header">
              <h3 className="cal-modal-title">Assign To</h3>
              <button
                type="button"
                onClick={() => {
                  setShowAssignOppModal(false);
                  setActivityToAssign(null);
                  setOppFilterText('');
                }}
                className="cal-modal-close"
              >
                ×
              </button>
            </div>
            <div className="cal-modal-body">
              <div className="cal-assign-modal__context">
                <div className="cal-activity-detail__field-label">Activity</div>
                <div className="cal-activity-detail__field-value--bold">
                  {activityToAssign.subject}
                </div>
              </div>
              <div className="cal-assign-modal__filter-wrap">
                <div className="cal-assign-modal__filter-inner">
                  <input
                    type="text"
                    placeholder="Filter..."
                    value={oppFilterText}
                    onChange={(e) => setOppFilterText(e.target.value)}
                    className="cal-assign-modal__filter-input"
                  />
                  {oppFilterText && (
                    <button
                      type="button"
                      onClick={() => setOppFilterText('')}
                      className="cal-assign-modal__filter-clear"
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
              <div className="cal-assign-modal__select-label">
                Select Record:
              </div>
            </div>
            <div className="cal-assign-modal__list">
              {(() => {
                const items: Array<{
                  id: string;
                  name: string;
                  type: 'Account' | 'Campaign' | 'Opportunity';
                  meta?: string;
                }> = [];
                (sfdcContext.accounts || []).forEach((acc: any) =>
                  items.push({ id: acc.id, name: acc.name, type: 'Account' }),
                );
                (sfdcContext.campaigns || []).forEach((camp: any) =>
                  items.push({
                    id: camp.id,
                    name: camp.name,
                    type: 'Campaign',
                    meta: camp.type,
                  }),
                );
                (sfdcContext.opportunities || []).forEach((opp: any) =>
                  items.push({
                    id: opp.id,
                    name: opp.name,
                    type: 'Opportunity',
                    meta: opp.stageName,
                  }),
                );
                const filtered = oppFilterText
                  ? items.filter((item) =>
                      item.name
                        .toLowerCase()
                        .includes(oppFilterText.toLowerCase()),
                    )
                  : items;
                return filtered.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={async () => {
                      setAssigningActivity(true);
                      try {
                        await crmProvider.updateTask(activityToAssign.id, {
                          relatedTo: {
                            type: item.type,
                            id: item.id,
                            name: item.name,
                          },
                        } as any);
                        showToast(
                          `Activity assigned to ${item.type.toLowerCase()}`,
                          'success',
                        );
                        setShowAssignOppModal(false);
                        setActivityToAssign(null);
                        if (selectedSfdcItem)
                          fetchTasksForItem(selectedSfdcItem);
                      } catch (err) {
                        log('Failed to assign activity:', err);
                        showToast('Failed to assign activity', 'error');
                      } finally {
                        setAssigningActivity(false);
                      }
                    }}
                    disabled={assigningActivity}
                    className={`cal-assign-modal__item ${assigningActivity ? 'cal-assign-modal__item--disabled' : ''}`}
                  >
                    <div className="cal-assign-modal__item-header">
                      <span className="cal-assign-modal__item-name">
                        {item.name}
                      </span>
                      <span
                        className={`cal-assign-modal__item-type cal-assign-modal__item-type--${item.type.toLowerCase()}`}
                      >
                        {item.type}
                      </span>
                    </div>
                    {item.meta && (
                      <div className="cal-assign-modal__item-meta">
                        {item.meta}
                      </div>
                    )}
                  </button>
                ));
              })()}
            </div>
          </div>
        </div>
      )}

      <SearchModal
        isOpen={showSearchModal}
        onClose={() => setShowSearchModal(false)}
        onSelect={handleSelectSearchResult}
        type={searchModalType}
        agentSlug="enterprise-assistant"
      />

      {/* Log Activity Modal */}
      {showLogActivityModal && sfdcContext && (
        <div className="log-activity-modal-overlay cal-modal-overlay cal-modal-overlay--z1000">
          <div className="log-activity-modal-container cal-modal-container log-activity-modal">
            <div className="log-activity-modal-header cal-modal-header cal-modal-header--rounded">
              <h3 className="cal-modal-title">
                Log Activity - {selectedEvent?.subject}
              </h3>
              <button
                type="button"
                onClick={() => {
                  setShowLogActivityModal(false);
                  setSelectedSfdcItem(null);
                }}
                className="cal-modal-close"
              >
                ×
              </button>
            </div>
            <div className="log-activity-modal-content log-activity-modal__content">
              {/* Left: Accounts & Opportunities */}
              <div className="log-activity-modal-sidebar log-activity-modal__sidebar">
                {sfdcContext.accounts && sfdcContext.accounts.length > 1 && (
                  <div className="log-activity__filter-section">
                    <div className="cal-assign-modal__filter-inner">
                      <input
                        type="text"
                        placeholder="Filter accounts..."
                        value={accountFilter}
                        onChange={(e) => setAccountFilter(e.target.value)}
                        className="cal-assign-modal__filter-input"
                      />
                      {accountFilter && (
                        <button
                          type="button"
                          onClick={() => setAccountFilter('')}
                          className="cal-assign-modal__filter-clear"
                        >
                          ×
                        </button>
                      )}
                    </div>
                    {accountFilter && (
                      <div className="log-activity__filter-count">
                        Showing{' '}
                        {
                          sfdcContext.accounts.filter((a: any) =>
                            a.name
                              .toLowerCase()
                              .includes(accountFilter.toLowerCase()),
                          ).length
                        }{' '}
                        of {sfdcContext.accounts.length} accounts
                      </div>
                    )}
                  </div>
                )}

                {sfdcContext.accounts && sfdcContext.accounts.length > 0 ? (
                  <details open className="log-activity__accounts">
                    <summary className="log-activity__section-summary">
                      <div className="log-activity__section-summary-inner">
                        <span>▼</span> Accounts ({sfdcContext.accounts.length})
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowSearchModal(true);
                        }}
                        className="log-activity__search-btn"
                        title="Search accounts or campaigns"
                        aria-label="Search accounts or campaigns"
                      >
                        <svg
                          aria-hidden="true"
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="11" cy="11" r="8" />
                          <path d="m21 21-4.35-4.35" />
                        </svg>
                      </button>
                    </summary>
                    {sfdcContext.accounts.map((account: any) => {
                      if (
                        accountFilter &&
                        !account.name
                          .toLowerCase()
                          .includes(accountFilter.toLowerCase())
                      )
                        return null;
                      const isAccountSelected =
                        selectedSfdcItem?.type === 'account' &&
                        selectedSfdcItem.data.id === account.id;
                      const isOpportunityOfThisAccount =
                        selectedSfdcItem?.type === 'opportunity' &&
                        sfdcContext.selectedAccountId === account.id;
                      return (
                        <button
                          type="button"
                          key={account.id}
                          className={`log-activity__account-btn ${isAccountSelected ? 'log-activity__account-btn--selected' : isOpportunityOfThisAccount ? 'log-activity__account-btn--parent' : 'log-activity__account-btn--default'}`}
                          onClick={() => {
                            const item = {
                              type: 'account' as const,
                              data: account,
                            };
                            if (isAccountSelected) return;
                            if (isOpportunityOfThisAccount) {
                              setSelectedSfdcItem(item);
                              fetchTasksForItem(item);
                              return;
                            }
                            setSelectedSfdcItem(item);
                            fetchTasksForItem(item);
                            prefillActivityData(item);
                            setLoadingOpportunities(true);
                            fetchOpportunitiesForAccount(
                              account.id,
                              '',
                            ).finally(() => setLoadingOpportunities(false));
                          }}
                        >
                          {account.name}
                        </button>
                      );
                    })}
                  </details>
                ) : (
                  <div className="log-activity__no-accounts">
                    <div className="log-activity__no-accounts-text">
                      No related accounts found
                    </div>
                    <div className="log-activity__no-accounts-actions">
                      <button
                        type="button"
                        onClick={() => fetchSFDCContext(true)}
                        disabled={loadingSFDC}
                        className={`log-activity__load-accounts-btn ${loadingSFDC ? 'log-activity__load-accounts-btn--disabled' : ''}`}
                      >
                        {loadingSFDC ? 'Loading...' : 'My Accounts'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowSearchModal(true)}
                        className="log-activity__search-accounts-btn"
                      >
                        Search Accounts/Campaigns
                      </button>
                    </div>
                  </div>
                )}

                {(selectedSfdcItem?.type === 'account' ||
                  selectedSfdcItem?.type === 'opportunity') &&
                  sfdcContext.opportunities &&
                  sfdcContext.opportunities.length > 0 && (
                    <div className="log-activity__opps-section">
                      <div style={{ marginBottom: '0.75rem' }}>
                        <label
                          className="log-activity__opps-filter-label"
                          htmlFor="cal-opportunity-filter"
                        >
                          Filter Opportunities
                        </label>
                        <div style={{ position: 'relative' }}>
                          <input
                            id="cal-opportunity-filter"
                            type="text"
                            value={opportunityKeyword}
                            onChange={(e) =>
                              setOpportunityKeyword(e.target.value)
                            }
                            placeholder="Filter by name..."
                            className="log-activity__opps-filter-input"
                          />
                          {opportunityKeyword && (
                            <button
                              type="button"
                              onClick={() => setOpportunityKeyword('')}
                              className="cal-assign-modal__filter-clear"
                            >
                              ×
                            </button>
                          )}
                        </div>
                        <label className="log-activity__hide-closed-label">
                          <input
                            type="checkbox"
                            checked={hideClosedOpportunities}
                            onChange={(e) =>
                              setHideClosedOpportunities(e.target.checked)
                            }
                          />
                          Hide Closed/Won
                        </label>
                      </div>
                      {loadingOpportunities ? (
                        <div className="log-activity__empty-msg">
                          Loading opportunities...
                        </div>
                      ) : (
                        (() => {
                          let filteredOpps = sfdcContext.opportunities || [];
                          if (hideClosedOpportunities)
                            filteredOpps = filteredOpps.filter(
                              (opp: any) =>
                                !opp.stageName
                                  ?.toLowerCase()
                                  .includes('closed') &&
                                !opp.stageName?.toLowerCase().includes('won') &&
                                !opp.stageName?.toLowerCase().includes('lost'),
                            );
                          if (opportunityKeyword.trim())
                            filteredOpps = filteredOpps.filter((opp: any) =>
                              opp.name
                                ?.toLowerCase()
                                .includes(opportunityKeyword.toLowerCase()),
                            );
                          return filteredOpps.length > 0 ? (
                            <details open>
                              <summary className="log-activity__section-summary">
                                <span>▼</span> Opportunities (
                                {filteredOpps.length})
                              </summary>
                              {filteredOpps.map((opp: any) => (
                                <button
                                  type="button"
                                  key={opp.id}
                                  onClick={() => {
                                    const item = {
                                      type: 'opportunity' as const,
                                      data: opp,
                                    };
                                    setSelectedSfdcItem(item);
                                    fetchTasksForItem(item);
                                  }}
                                  className={`log-activity__opp-btn ${selectedSfdcItem?.type === 'opportunity' && selectedSfdcItem.data.id === opp.id ? 'log-activity__opp-btn--selected' : 'log-activity__opp-btn--default'}`}
                                >
                                  <div className="log-activity__opp-name">
                                    {opp.name}
                                  </div>
                                  <div className="log-activity__opp-stage">
                                    {opp.stageName}
                                  </div>
                                </button>
                              ))}
                            </details>
                          ) : (
                            <div className="log-activity__empty-msg">
                              {opportunityKeyword || hideClosedOpportunities
                                ? 'No opportunities match the current filters'
                                : 'No opportunities found'}
                            </div>
                          );
                        })()
                      )}
                    </div>
                  )}

                {sfdcContext.campaigns && sfdcContext.campaigns.length > 0 && (
                  <div className="log-activity__campaigns-section">
                    <details open>
                      <summary className="log-activity__section-summary">
                        <span>▼</span> Campaigns ({sfdcContext.campaigns.length}
                        )
                      </summary>
                      {sfdcContext.campaigns.map((campaign: any) => (
                        <button
                          type="button"
                          key={campaign.id}
                          onClick={() => {
                            const item = {
                              type: 'campaign' as const,
                              data: campaign,
                            };
                            setSelectedSfdcItem(item);
                            fetchTasksForItem(item);
                            prefillActivityData(item);
                          }}
                          className={`log-activity__campaign-btn ${selectedSfdcItem?.type === 'campaign' && selectedSfdcItem.data.id === campaign.id ? 'log-activity__campaign-btn--selected' : 'log-activity__campaign-btn--default'}`}
                        >
                          <div className="log-activity__opp-name">
                            {campaign.name}
                          </div>
                          {campaign.type && (
                            <div className="log-activity__opp-stage">
                              {campaign.type}
                            </div>
                          )}
                        </button>
                      ))}
                    </details>
                  </div>
                )}
              </div>

              {/* Right: Activity Form */}
              <div className="log-activity-modal-form log-activity-modal__form">
                {selectedSfdcItem ? (
                  <div className="log-activity__form-fields">
                    <div className="log-activity__context-card">
                      <a
                        href={`${CRM_BASE_URL}/r/${selectedSfdcItem.type === 'account' ? 'Account' : selectedSfdcItem.type === 'campaign' ? 'Campaign' : 'Opportunity'}/${selectedSfdcItem.data.id}/view`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="log-activity__context-sfdc"
                        title="Open in CRM"
                      >
                        ↗
                      </a>
                      <div className="log-activity__context-type">
                        {selectedSfdcItem.type === 'account'
                          ? 'Account'
                          : selectedSfdcItem.type === 'campaign'
                            ? 'Campaign'
                            : 'Opportunity'}
                      </div>
                      <div className="log-activity__context-name">
                        {selectedSfdcItem.data.name}
                      </div>
                      <div className="log-activity__context-id">
                        {selectedSfdcItem.data.id}
                      </div>
                      {selectedSfdcItem.type === 'opportunity' &&
                        selectedSfdcItem.data.stageName && (
                          <div className="log-activity__context-stage">
                            Stage: {selectedSfdcItem.data.stageName}
                          </div>
                        )}
                      {selectedSfdcItem.type === 'campaign' &&
                        selectedSfdcItem.data.type && (
                          <div className="log-activity__context-stage">
                            Type: {selectedSfdcItem.data.type}
                          </div>
                        )}
                    </div>

                    <div style={{ position: 'relative' }}>
                      {loadingActivityPrefill && (
                        <div className="log-activity__prefill-overlay">
                          <div className="log-activity__prefill-text">
                            <span
                              style={{
                                animation: 'spin 1s linear infinite',
                                display: 'inline-block',
                              }}
                            >
                              ⟳
                            </span>{' '}
                            Generating activity details...
                          </div>
                        </div>
                      )}
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '1.25rem',
                        }}
                      >
                        <div>
                          <label
                            className="log-activity__field-label"
                            htmlFor="cal-activity-subject"
                          >
                            Subject{' '}
                            <span className="log-activity__required">*</span>
                          </label>
                          <input
                            id="cal-activity-subject"
                            type="text"
                            value={activityFormData.subject}
                            onChange={(e) =>
                              setActivityFormData({
                                ...activityFormData,
                                subject: e.target.value,
                              })
                            }
                            placeholder="Brief summary of the activity"
                            className="log-activity__field-input"
                          />
                        </div>
                        <div>
                          <label
                            className="log-activity__field-label"
                            htmlFor="cal-activity-type"
                          >
                            Activity Type{' '}
                            <span className="log-activity__required">*</span>
                          </label>
                          <select
                            id="cal-activity-type"
                            value={activityFormData.activityType}
                            onChange={(e) =>
                              setActivityFormData({
                                ...activityFormData,
                                activityType: e.target.value,
                              })
                            }
                            className="log-activity__field-input"
                          >
                            <option value="">Select activity type...</option>
                            <optgroup label="Architecture">
                              <option value="Architecture Review">
                                Architecture Review
                              </option>
                              <option value="Cloud Adoption Framework">
                                Cloud Adoption Framework
                              </option>
                              <option value="Demo">Demo</option>
                              <option value="Foundational Technical Review">
                                Foundational Technical Review
                              </option>
                              <option value="Migration Readiness Assessment">
                                Migration Readiness Assessment
                              </option>
                              <option value="Migration/Modernization Acceleration">
                                Migration/Modernization Acceleration
                              </option>
                              <option value="Other Architecture Advice">
                                Other Architecture Advice
                              </option>
                              <option value="Prototype/PoC/Pilot">
                                Prototype/PoC/Pilot
                              </option>
                              <option value="Security, Resilience and Compliance">
                                Security, Resilience and Compliance
                              </option>
                              <option value="Well Architected">
                                Well Architected
                              </option>
                            </optgroup>
                            <optgroup label="Management">
                              <option value="Account Planning">
                                Account Planning
                              </option>
                              <option value="Cost Optimization">
                                Cost Optimization
                              </option>
                              <option value="Meeting / Office Hours">
                                Meeting / Office Hours
                              </option>
                              <option value="RFI and RFP response">
                                RFI and RFP response
                              </option>
                              <option value="Support/Escalation">
                                Support/Escalation
                              </option>
                            </optgroup>
                            <optgroup label="Workshops">
                              <option value="Activation Day">
                                Activation Day
                              </option>
                              <option value="GameDay">GameDay</option>
                              <option value="Hackathon">Hackathon</option>
                              <option value="Immersion Day">
                                Immersion Day
                              </option>
                              <option value="Other Workshops">
                                Other Workshops
                              </option>
                            </optgroup>
                            <optgroup label="Program Execution">
                              <option value="CCoE">
                                CCoE (Cloud Center of Excellence)
                              </option>
                              <option value="EBA">
                                EBA (Experience Based Acceleration)
                              </option>
                              <option value="EBC">
                                EBC (Executive Briefing Centre)
                              </option>
                              <option value="MAP">
                                MAP (Migration Acceleration Program)
                              </option>
                              <option value="Other Program Execution">
                                Other Program Execution
                              </option>
                            </optgroup>
                          </select>
                        </div>
                        <div>
                          <label
                            className="log-activity__field-label"
                            htmlFor="cal-activity-date"
                          >
                            Activity Date{' '}
                            <span className="log-activity__required">*</span>
                          </label>
                          <input
                            id="cal-activity-date"
                            type="date"
                            value={activityFormData.activityDate}
                            onChange={(e) =>
                              setActivityFormData({
                                ...activityFormData,
                                activityDate: e.target.value,
                              })
                            }
                            className="log-activity__field-input log-activity__field-input--date"
                          />
                        </div>
                        <div>
                          <label
                            className="log-activity__field-label"
                            htmlFor="cal-activity-description"
                          >
                            Description
                          </label>
                          <textarea
                            id="cal-activity-description"
                            value={activityFormData.description}
                            onChange={(e) =>
                              setActivityFormData({
                                ...activityFormData,
                                description: e.target.value,
                              })
                            }
                            placeholder="Detailed notes about the activity..."
                            rows={6}
                            className="log-activity__field-textarea"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="log-activity__submit-section">
                      <button
                        type="button"
                        onClick={async () => {
                          if (!selectedSfdcItem) return;
                          setSubmittingActivity(true);
                          try {
                            const task = await crmProvider.createTask({
                              subject: activityFormData.subject,
                              activityType: activityFormData.activityType,
                              dueDate: activityFormData.activityDate
                                ? new Date(activityFormData.activityDate)
                                : undefined,
                              description: activityFormData.description,
                              relatedTo: {
                                type: selectedSfdcItem.type,
                                id: selectedSfdcItem.data.id,
                                name: selectedSfdcItem.data.name,
                              },
                              status: 'open',
                            } as any);
                            const taskId = (task as any)?.id;
                            if (taskId && selectedEvent) {
                              setSalesState({
                                ...salesState,
                                loggedActivities: {
                                  ...salesState.loggedActivities,
                                  [selectedEvent.meetingId]: {
                                    id: taskId,
                                    subject: activityFormData.subject,
                                  },
                                },
                              });
                            }
                            if (taskId) {
                              notify({
                                title: 'Activity logged successfully',
                                message: (
                                  <a
                                    href={`${CRM_BASE_URL}/r/Task/${taskId}/view`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{
                                      color: 'var(--color-primary)',
                                      textDecoration: 'underline',
                                    }}
                                  >
                                    {activityFormData.subject}
                                  </a>
                                ) as any,
                                type: 'success',
                              });
                            } else {
                              showToast(
                                'Activity logged successfully',
                                'success',
                              );
                            }
                            setShowLogActivityModal(false);
                            setSelectedSfdcItem(null);
                            if (selectedSfdcItem)
                              fetchTasksForItem(selectedSfdcItem);
                          } catch (err) {
                            log('Failed to log activity:', err);
                            showToast('Failed to log activity', 'error');
                          } finally {
                            setSubmittingActivity(false);
                          }
                        }}
                        disabled={
                          !activityFormData.subject ||
                          !activityFormData.activityType ||
                          submittingActivity
                        }
                        className={`log-activity__submit-btn ${!activityFormData.subject || !activityFormData.activityType || submittingActivity ? 'log-activity__submit-btn--disabled' : 'log-activity__submit-btn--enabled'}`}
                      >
                        {submittingActivity ? 'Logging...' : 'Log Activity'}
                      </button>
                    </div>

                    {loadingTasks ? (
                      <div className="log-activity__tasks-loading">
                        <span
                          style={{
                            animation: 'spin 1s linear infinite',
                            display: 'inline-block',
                            marginRight: '0.5rem',
                          }}
                        >
                          ⟳
                        </span>
                        Loading activities...
                      </div>
                    ) : (
                      sfdcContext.tasks &&
                      sfdcContext.tasks.length > 0 && (
                        <details open className="log-activity__tasks-section">
                          <summary className="log-activity__section-summary">
                            <span>▼</span> Recent Activities (
                            {sfdcContext.tasks.length})
                          </summary>
                          <div className="log-activity__tasks-list">
                            {sfdcContext.tasks
                              .slice(0, showAllTasks ? undefined : 5)
                              .map((task: any, idx: number) => (
                                <div
                                  key={task.id || idx}
                                  className="log-activity__task-card"
                                >
                                  <div className="log-activity__task-actions">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setActivityToAssign(task);
                                        setShowAssignOppModal(true);
                                        setOppFilterText('');
                                      }}
                                      className="log-activity__task-assign-btn"
                                      title="Assign to account, opportunity, or campaign"
                                    >
                                      Assign To...
                                    </button>
                                    {task.id && (
                                      <a
                                        href={`${CRM_BASE_URL}/r/Task/${task.id}/view`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="log-activity__task-sfdc"
                                        title="Open in CRM"
                                      >
                                        ↗
                                      </a>
                                    )}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      setShowActivityDetailModal(true);
                                      setLoadingActivityDetails(true);
                                      try {
                                        const taskVM =
                                          await crmProvider.getTaskDetails(
                                            task.id,
                                          );
                                        setSelectedActivity({
                                          id: taskVM.id,
                                          subject: taskVM.subject,
                                          status: taskVM.status,
                                          activityDate:
                                            (taskVM as any).dueDate instanceof
                                            Date
                                              ? (taskVM as any).dueDate
                                                  .toISOString()
                                                  .split('T')[0]
                                              : (taskVM as any).dueDate,
                                          description: taskVM.description,
                                          priority: taskVM.priority,
                                          activityType: taskVM.activityType,
                                          what: (taskVM as any).relatedTo
                                            ? {
                                                __typename: (taskVM as any)
                                                  .relatedTo.type,
                                                name: (taskVM as any).relatedTo
                                                  .name,
                                              }
                                            : undefined,
                                          whatId: (taskVM as any).relatedTo?.id,
                                        });
                                      } catch (err) {
                                        log(
                                          'Failed to fetch task details:',
                                          err,
                                        );
                                        setSelectedActivity(task);
                                      } finally {
                                        setLoadingActivityDetails(false);
                                      }
                                    }}
                                    className="log-activity__task-btn"
                                  >
                                    <div className="log-activity__task-subject">
                                      {task.subject}
                                    </div>
                                    {task.activityType && (
                                      <div className="log-activity__task-meta">
                                        {task.activityType}
                                      </div>
                                    )}
                                    {task.what?.name && (
                                      <div className="log-activity__task-meta">
                                        {task.what.name}
                                      </div>
                                    )}
                                    {task.activityDate && (
                                      <div className="log-activity__task-meta">
                                        {task.activityDate}
                                      </div>
                                    )}
                                    {task.status && (
                                      <div className="log-activity__task-meta">
                                        Status: {task.status}
                                      </div>
                                    )}
                                  </button>
                                </div>
                              ))}
                            {sfdcContext.tasks.length > 5 && (
                              <button
                                type="button"
                                onClick={() => setShowAllTasks(!showAllTasks)}
                                className="log-activity__show-more-btn"
                              >
                                {showAllTasks
                                  ? 'Show Less'
                                  : `Show ${sfdcContext.tasks.length - 5} More`}
                              </button>
                            )}
                            {showAllTasks && tasksCursor && (
                              <button
                                type="button"
                                onClick={async () => {
                                  const userId = salesContext.myDetails?.id;
                                  if (!userId || !selectedSfdcItem) return;
                                  const filters: any = {
                                    limit: 25,
                                    after: tasksCursor,
                                  };
                                  if (selectedSfdcItem.type === 'opportunity')
                                    filters.opportunityId =
                                      selectedSfdcItem.data.id;
                                  else if (selectedSfdcItem.type === 'account')
                                    filters.accountId =
                                      selectedSfdcItem.data.id;
                                  const result = await crmProvider.getUserTasks(
                                    userId,
                                    filters,
                                  );
                                  const mapped = result.tasks.map((t: any) => ({
                                    id: t.id,
                                    subject: t.subject,
                                    status: t.status,
                                    activityDate:
                                      t.dueDate instanceof Date
                                        ? t.dueDate.toISOString().split('T')[0]
                                        : t.dueDate,
                                    description: t.description,
                                    priority: t.priority,
                                    activityType: t.activityType,
                                    what: t.relatedTo
                                      ? {
                                          __typename: t.relatedTo.type,
                                          name: t.relatedTo.name,
                                        }
                                      : undefined,
                                    whatId: t.relatedTo?.id,
                                  }));
                                  setSfdcContext((prev) => ({
                                    ...prev,
                                    tasks: [...(prev?.tasks || []), ...mapped],
                                  }));
                                  setTasksCursor(
                                    (result as any).hasNextPage
                                      ? (result as any).cursor
                                      : undefined,
                                  );
                                }}
                                className="log-activity__load-more-btn"
                              >
                                Load More…
                              </button>
                            )}
                          </div>
                        </details>
                      )
                    )}
                  </div>
                ) : (
                  <div className="log-activity__empty-form">
                    Select an account or opportunity to log activity
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {showCreateEventModal && (
        <CreateEventModal
          selectedDate={selectedDate}
          onClose={() => {
            setShowCreateEventModal(false);
            setEventModalData(undefined);
          }}
          isPending={createEvent.isPending || updateEvent.isPending}
          initial={eventModalData}
          onSubmit={(input) => {
            createEvent.mutate(input, {
              onSuccess: () => {
                showToast('Event created');
                setShowCreateEventModal(false);
                setEventModalData(undefined);
              },
              onError: () => showToast('Failed to create event'),
            });
          }}
          onUpdate={(input) => {
            updateEvent.mutate(input, {
              onSuccess: () => {
                showToast('Event updated');
                setShowCreateEventModal(false);
                setEventModalData(undefined);
              },
              onError: () => showToast('Failed to update event'),
            });
          }}
        />
      )}
      <ConfirmModal
        isOpen={!!confirmDeleteEvent}
        title="Delete Event"
        message={`Delete "${confirmDeleteEvent?.subject}"? This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {
          if (confirmDeleteEvent) {
            deleteEvent.mutate(confirmDeleteEvent.meetingId, {
              onSuccess: () => {
                showToast('Event deleted');
                if (selectedEventId === confirmDeleteEvent.meetingId)
                  clearSelection();
                setConfirmDeleteEvent(null);
              },
              onError: () => {
                showToast('Failed to delete event');
                setConfirmDeleteEvent(null);
              },
            });
          }
        }}
        onCancel={() => setConfirmDeleteEvent(null)}
      />
    </div>
  );
}
