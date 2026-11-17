import { useMemo, useState } from 'react';
import { Check, CheckCircle2, Inbox, Loader2, UserPlus, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import type { FriendRequest } from '../types';
import { formatChatListTime } from '../utils/chatHelpers';
import { Avatar } from './Avatar';

export interface FriendRequestsViewProps {
  requests?: FriendRequest[];
  onAccept?: (requestId: string) => Promise<void>;
  onReject?: (requestId: string) => Promise<void>;
  emptyTitle?: string;
  emptyDescription?: string;
}

export function FriendRequestsView({
  requests,
  onAccept,
  onReject,
  emptyTitle = 'No incoming friend requests',
  emptyDescription = 'When someone sends you a friend request by username or email, it will appear here for you to accept or reject.',
}: FriendRequestsViewProps) {
  const {
    firebaseUser,
    publicProfile,
    friendRequests,
    acceptFriendRequest,
    rejectFriendRequest,
  } = useAuth();

  const [processingMap, setProcessingMap] = useState<
    Record<string, 'accept' | 'reject' | undefined>
  >({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);

  const currentUid = publicProfile?.uid || firebaseUser?.uid || '';

  const incomingRequests = useMemo(() => {
    const source = requests ?? friendRequests;
    return source.filter(
      (req) => req.receiverUid === currentUid && req.status === 'pending'
    );
  }, [requests, friendRequests, currentUid]);

  const handleAction = async (
    req: FriendRequest,
    action: 'accept' | 'reject'
  ) => {
    if (processingMap[req.id]) return;
    setErrorMessage(null);
    setFeedbackMessage(null);
    setProcessingMap((prev) => ({ ...prev, [req.id]: action }));

    try {
      if (action === 'accept') {
        await (onAccept ? onAccept(req.id) : acceptFriendRequest(req.id));
        setFeedbackMessage(`You and ${req.senderName} are now friends.`);
      } else {
        await (onReject ? onReject(req.id) : rejectFriendRequest(req.id));
        setFeedbackMessage(`Declined friend request from ${req.senderName}.`);
      }
    } catch (err) {
      let msg = `Could not ${action} friend request. Please try again.`;
      if (err instanceof Error && err.message) {
        try {
          const parsed = JSON.parse(err.message) as { error?: string };
          if (parsed?.error) {
            msg = parsed.error;
          }
        } catch {
          msg = err.message;
        }
      }
      setErrorMessage(msg);
    } finally {
      setProcessingMap((prev) => {
        const next = { ...prev };
        delete next[req.id];
        return next;
      });
    }
  };

  return (
    <section
      aria-label="Incoming friend requests"
      className="space-y-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <UserPlus className="w-4 h-4 text-[#008069] dark:text-[#00A884] shrink-0" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[#54656F] dark:text-[#AEBAC1] truncate">
            Incoming Friend Requests
          </h3>
        </div>
        <span className="text-xs font-semibold tabular-nums text-[#008069] dark:text-[#00A884] shrink-0">
          {incomingRequests.length}
        </span>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-start justify-between gap-2 text-xs text-red-700 dark:text-red-300"
        >
          <span>{errorMessage}</span>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            aria-label="Dismiss error"
            className="text-red-600 dark:text-red-300 hover:opacity-80 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {feedbackMessage && (
        <div
          role="status"
          className="p-3 rounded-xl bg-[#00A884]/12 border border-[#00A884]/25 flex items-center justify-between gap-2 text-xs text-[#008069] dark:text-[#00A884]"
        >
          <span className="inline-flex items-center gap-1.5 font-medium">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{feedbackMessage}</span>
          </span>
          <button
            type="button"
            onClick={() => setFeedbackMessage(null)}
            aria-label="Dismiss status message"
            className="hover:opacity-80 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {incomingRequests.length === 0 ? (
        <div className="py-6 px-4 rounded-xl bg-[#F0F2F5] dark:bg-[#202C33] text-center">
          <div className="w-10 h-10 rounded-xl bg-[#00A884]/12 text-[#008069] dark:text-[#00A884] flex items-center justify-center mx-auto mb-2.5">
            <Inbox className="w-5 h-5" />
          </div>
          <p className="text-xs font-semibold text-[#111B21] dark:text-[#E9EDEF]">
            {emptyTitle}
          </p>
          <p className="text-[11px] text-[#667781] dark:text-[#8696A0] mt-1 leading-relaxed">
            {emptyDescription}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-[#E9EDEF] dark:divide-[#222E35] rounded-xl bg-[#F0F2F5] dark:bg-[#202C33] overflow-hidden">
          {incomingRequests.map((req) => {
            const busyAction = processingMap[req.id];
            const isBusy = Boolean(busyAction);
            const sentTime = req.createdAt ? formatChatListTime(req.createdAt) : '';

            return (
              <div
                key={req.id}
                className="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar
                    src={req.senderPhoto}
                    name={req.senderName}
                    size="sm"
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#111B21] dark:text-[#E9EDEF] truncate">
                      {req.senderName}
                    </div>
                    <div className="text-xs text-[#667781] dark:text-[#8696A0] truncate">
                      <span>@{req.senderUsername || 'user'}</span>
                      {sentTime && (
                        <>
                          <span aria-hidden="true"> · </span>
                          <span>{sentTime}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void handleAction(req, 'accept')}
                    aria-label={`Accept friend request from ${req.senderName}`}
                    className="min-h-[40px] px-3.5 py-2 rounded-lg bg-[#008069] hover:bg-[#006B57] disabled:opacity-60 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    {busyAction === 'accept' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Check className="w-3.5 h-3.5" />
                    )}
                    <span>Accept</span>
                  </button>

                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void handleAction(req, 'reject')}
                    aria-label={`Reject friend request from ${req.senderName}`}
                    className="min-h-[40px] px-3.5 py-2 rounded-lg bg-white dark:bg-[#111B21] border border-[#D1D7DB] dark:border-[#2A3942] hover:bg-red-50 dark:hover:bg-red-500/10 hover:border-red-300 dark:hover:border-red-500/30 disabled:opacity-60 text-[#54656F] dark:text-[#E9EDEF] hover:text-red-700 dark:hover:text-red-300 text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    {busyAction === 'reject' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <X className="w-3.5 h-3.5" />
                    )}
                    <span>Reject</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default FriendRequestsView;
