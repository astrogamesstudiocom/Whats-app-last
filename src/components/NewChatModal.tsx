import React, { useMemo, useState } from 'react';
import { Check, Copy, Loader2, Search, UserPlus, Users, X } from 'lucide-react';
import { collection, doc, getDoc, getDocs, limit, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { BLUEPRINT_LIMITS, type PublicProfile } from '../types';
import { Avatar } from './Avatar';

interface NewChatModalProps {
  directoryUsers: PublicProfile[];
  allowGroupCreation?: boolean;
  onStartDirectChat: (peer: PublicProfile) => Promise<void>;
  onCreateGroupChat: (
    title: string,
    memberUids: string[],
    description?: string
  ) => Promise<void>;
  onClose: () => void;
}

function parseActionError(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) {
    try {
      const parsed = JSON.parse(err.message) as { error?: string };
      if (parsed?.error) return parsed.error;
    } catch {
      return err.message;
    }
  }
  return fallback;
}

export function NewChatModal({
  directoryUsers,
  allowGroupCreation = true,
  onStartDirectChat,
  onCreateGroupChat,
  onClose,
}: NewChatModalProps) {
  const {
    publicProfile,
    friendRequests,
    sendFriendRequest,
    acceptFriendRequest,
    rejectFriendRequest,
    cancelFriendRequest,
    getFriendshipStatus,
  } = useAuth();
  const [mode, setMode] = useState<'direct' | 'group'>('direct');
  const [searchQuery, setSearchQuery] = useState('');
  const [exactMatch, setExactMatch] = useState<PublicProfile | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [friendActionBusyUid, setFriendActionBusyUid] = useState<string | null>(null);
  const [friendActionError, setFriendActionError] = useState<string | null>(null);
  const [friendActionSuccess, setFriendActionSuccess] = useState<string | null>(null);

  const [groupTitle, setGroupTitle] = useState('');
  const [groupDescription, setGroupDescription] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<PublicProfile[]>([]);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const selectedUids = useMemo(() => selectedMembers.map((m) => m.uid), [selectedMembers]);

  const others = useMemo(
    () => directoryUsers.filter((u) => u.uid !== publicProfile?.uid),
    [directoryUsers, publicProfile?.uid]
  );

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase().replace(/^@/, '');
    if (!q) return others;
    return others.filter(
      (u) =>
        u.displayName.toLowerCase().includes(q) ||
        u.username.toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q)
    );
  }, [others, searchQuery]);

  const runFriendAction = async (
    targetUid: string,
    action: () => Promise<void>,
    successMsg: string,
    fallbackError: string
  ) => {
    setFriendActionBusyUid(targetUid);
    setFriendActionError(null);
    setFriendActionSuccess(null);
    try {
      await action();
      setFriendActionSuccess(successMsg);
    } catch (err) {
      console.error('[FriendRequests] Action failed in NewChatModal:', err);
      setFriendActionError(parseActionError(err, fallbackError));
    } finally {
      setFriendActionBusyUid(null);
    }
  };

  const handleExactLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = searchQuery.trim().toLowerCase();
    if (!raw) return;

    setLookupLoading(true);
    setLookupError(null);
    setFriendActionError(null);
    setExactMatch(null);

    try {
      if (raw.includes('@') && raw.includes('.') && !raw.startsWith('@')) {
        if (raw === (publicProfile?.email || '').toLowerCase()) {
          setLookupError('That is your own email address.');
          return;
        }
        const q = query(
          collection(db, 'publicProfiles'),
          where('email', '==', raw),
          where('isDiscoverable', '==', true),
          limit(1)
        );
        const snap = await getDocs(q);
        if (snap.empty) {
          setLookupError(`No discoverable user found with email ${raw}. Try searching by @handle.`);
          return;
        }
        const matched = snap.docs[0].data() as PublicProfile;
        if (matched.uid === publicProfile?.uid) {
          setLookupError('That is your own account.');
          return;
        }
        setExactMatch(matched);
        return;
      }

      const clean = raw.replace(/^@/, '');
      if (!BLUEPRINT_LIMITS.USERNAME_PATTERN.test(clean)) {
        setLookupError('Enter a valid @handle (3–24 letters, numbers, underscores) or email address.');
        return;
      }

      const unameSnap = await getDoc(doc(db, 'usernames', clean));
      if (!unameSnap.exists()) {
        setLookupError(`No user found with handle @${clean}.`);
        return;
      }
      const uid = unameSnap.data().uid as string;
      if (uid === publicProfile?.uid) {
        setLookupError('That is your own handle.');
        return;
      }
      const profSnap = await getDoc(doc(db, 'publicProfiles', uid));
      if (!profSnap.exists()) {
        setLookupError('User profile is unavailable.');
        return;
      }
      setExactMatch(profSnap.data() as PublicProfile);
    } catch (err) {
      console.error('[NewChatModal] User lookup failed:', err);
      setLookupError(parseActionError(err, 'Could not look up that user right now.'));
    } finally {
      setLookupLoading(false);
    }
  };

  const toggleGroupMember = (person: PublicProfile) => {
    setGroupError(null);
    setSelectedMembers((prev) => {
      const exists = prev.some((m) => m.uid === person.uid);
      if (exists) {
        return prev.filter((m) => m.uid !== person.uid);
      }
      if (prev.length >= BLUEPRINT_LIMITS.MAX_PARTICIPANTS - 1) {
        setGroupError(`Groups support up to ${BLUEPRINT_LIMITS.MAX_PARTICIPANTS} participants total.`);
        return prev;
      }
      return [...prev, person];
    });
  };

  const handleGroupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupTitle.trim() || selectedMembers.length === 0) return;
    setBusy(true);
    setGroupError(null);
    try {
      await onCreateGroupChat(groupTitle.trim(), selectedUids, groupDescription.trim());
      onClose();
    } catch (err) {
      setGroupError(err instanceof Error ? err.message : 'Could not create group chat.');
    } finally {
      setBusy(false);
    }
  };

  const handleCopyInvite = async () => {
    const shareText = `Message or call me on VerdeChat (${window.location.origin}) — find my handle @${publicProfile?.username}`;
    try {
      await navigator.clipboard.writeText(shareText);
      setCopiedUrl(true);
      window.setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      // Clipboard fallback ignored
    }
  };

  const renderDirectActions = (person: PublicProfile) => {
    const status = getFriendshipStatus(person.uid);
    const req = friendRequests.find(
      (r) => r.senderUid === person.uid || r.receiverUid === person.uid
    );
    const isRowBusy = friendActionBusyUid === person.uid;

    return (
      <div className="flex items-center gap-1.5 shrink-0">
        {status === 'friends' && (
          <button
            type="button"
            disabled={busy || isRowBusy}
            onClick={async () => {
              setBusy(true);
              try {
                await onStartDirectChat(person);
                onClose();
              } catch (err) {
                console.error('[NewChatModal] Failed to open direct chat:', err);
                setFriendActionError(parseActionError(err, 'Could not start chat.'));
              } finally {
                setBusy(false);
              }
            }}
            className="px-3 py-1 rounded-lg bg-[#008069] text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
          >
            Chat
          </button>
        )}
        {status === 'pending_sent' && (
          <button
            type="button"
            disabled={isRowBusy}
            onClick={() => {
              if (!req) return;
              void runFriendAction(
                person.uid,
                () => cancelFriendRequest(req.id),
                `Cancelled friend request to ${person.displayName}.`,
                'Could not cancel friend request.'
              );
            }}
            className="px-2.5 py-1 rounded-lg bg-[#F0F2F5] dark:bg-[#202C33] text-[#667781] dark:text-[#8696A0] text-xs font-medium cursor-pointer hover:bg-red-50 hover:text-red-600 disabled:opacity-50 inline-flex items-center gap-1"
          >
            {isRowBusy && <Loader2 className="w-3 h-3 animate-spin" />}
            <span>Request Sent (Cancel)</span>
          </button>
        )}
        {status === 'pending_received' && req && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={isRowBusy}
              onClick={() =>
                void runFriendAction(
                  person.uid,
                  () => acceptFriendRequest(req.id),
                  `You and ${person.displayName} are now friends.`,
                  'Could not accept friend request.'
                )
              }
              className="px-2.5 py-1 rounded-lg bg-[#008069] text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
            >
              Accept
            </button>
            <button
              type="button"
              disabled={isRowBusy}
              onClick={() =>
                void runFriendAction(
                  person.uid,
                  () => rejectFriendRequest(req.id),
                  `Declined friend request from ${person.displayName}.`,
                  'Could not reject friend request.'
                )
              }
              className="px-2 py-1 rounded-lg bg-red-100 text-red-700 text-xs font-medium cursor-pointer disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        )}
        {status === 'none' && (
          <button
            type="button"
            disabled={isRowBusy}
            onClick={() =>
              void runFriendAction(
                person.uid,
                () => sendFriendRequest(person),
                `Friend request sent to ${person.displayName}!`,
                'Could not send friend request.'
              )
            }
            className="px-3 py-1 rounded-lg bg-[#00A884]/15 text-[#008069] dark:text-[#00A884] text-xs font-semibold cursor-pointer hover:bg-[#00A884]/25 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {isRowBusy && <Loader2 className="w-3 h-3 animate-spin" />}
            <span>{isRowBusy ? 'Sending...' : 'Add Friend'}</span>
          </button>
        )}
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Start new conversation"
    >
      <div className="w-full max-w-md bg-white dark:bg-[#111B21] border border-[#E9EDEF] dark:border-[#222E35] rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-[88dvh]">
        {/* Modal Header */}
        <div className="px-5 py-4 border-b border-[#E9EDEF] dark:border-[#222E35] flex items-center justify-between">
          <h2 className="text-base font-semibold text-[#111B21] dark:text-[#E9EDEF]">
            New Conversation
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="min-w-[36px] min-h-[36px] rounded-full hover:bg-[#F0F2F5] dark:hover:bg-[#202C33] flex items-center justify-center text-[#54656F] dark:text-[#8696A0] cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode Switch */}
        <div className="px-5 pt-3">
          <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-[#F0F2F5] dark:bg-[#202C33]">
            <button
              type="button"
              onClick={() => setMode('direct')}
              className={`py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                mode === 'direct'
                  ? 'bg-white dark:bg-[#111B21] text-[#111B21] dark:text-[#E9EDEF] shadow-xs'
                  : 'text-[#54656F] dark:text-[#8696A0]'
              }`}
            >
              <UserPlus className="w-3.5 h-3.5" />
              Direct Chat
            </button>
            <button
              type="button"
              disabled={!allowGroupCreation}
              onClick={() => setMode('group')}
              className={`py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-45 ${
                mode === 'group'
                  ? 'bg-white dark:bg-[#111B21] text-[#111B21] dark:text-[#E9EDEF] shadow-xs'
                  : 'text-[#54656F] dark:text-[#8696A0]'
              }`}
            >
              <Users className="w-3.5 h-3.5" />
              {allowGroupCreation ? 'New Group' : 'Groups Paused'}
            </button>
          </div>
        </div>

        {mode === 'group' && allowGroupCreation && (
          <form onSubmit={handleGroupSubmit} className="px-5 pt-3 space-y-2.5">
            <input
              type="text"
              required
              maxLength={BLUEPRINT_LIMITS.CHAT_TITLE_MAX}
              value={groupTitle}
              onChange={(e) => setGroupTitle(e.target.value)}
              placeholder="Group name (e.g. Weekend Trip)"
              className="w-full px-3.5 py-2.5 rounded-xl bg-[#F0F2F5] dark:bg-[#202C33] text-sm text-[#111B21] dark:text-[#E9EDEF] outline-none border border-transparent focus:border-[#00A884]"
            />
            <input
              type="text"
              maxLength={BLUEPRINT_LIMITS.GROUP_DESCRIPTION_MAX}
              value={groupDescription}
              onChange={(e) => setGroupDescription(e.target.value)}
              placeholder="Group topic or description (optional)"
              className="w-full px-3.5 py-2 rounded-xl bg-[#F0F2F5] dark:bg-[#202C33] text-xs text-[#111B21] dark:text-[#E9EDEF] outline-none border border-transparent focus:border-[#00A884]"
            />

            {selectedMembers.length > 0 && (
              <div className="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto pt-0.5">
                {selectedMembers.map((member) => (
                  <button
                    key={member.uid}
                    type="button"
                    onClick={() => toggleGroupMember(member)}
                    className="inline-flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-lg bg-[#00A884]/15 text-[#008069] dark:text-[#00A884] text-xs font-medium cursor-pointer"
                  >
                    <span className="truncate max-w-[120px]">{member.displayName}</span>
                    <X className="w-3.5 h-3.5 shrink-0" />
                  </button>
                ))}
              </div>
            )}

            {groupError && (
              <p className="text-xs text-red-600 dark:text-red-400">{groupError}</p>
            )}

            <div className="flex items-center justify-between text-xs text-[#667781] dark:text-[#8696A0]">
              <span className="tabular-nums">
                {selectedMembers.length} / {BLUEPRINT_LIMITS.MAX_PARTICIPANTS - 1} participants selected
              </span>
              <button
                type="submit"
                disabled={busy || !groupTitle.trim() || selectedMembers.length === 0}
                className="px-4 py-1.5 rounded-lg bg-[#008069] hover:bg-[#006B57] disabled:opacity-50 text-white font-semibold cursor-pointer inline-flex items-center gap-1.5"
              >
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>{busy ? 'Creating...' : 'Create Group'}</span>
              </button>
            </div>
          </form>
        )}

        {/* Search / Exact Handle or Email Form */}
        <form onSubmit={handleExactLookup} className="px-5 py-3 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-[#667781] dark:text-[#8696A0] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setLookupError(null);
              }}
              placeholder={
                mode === 'group'
                  ? 'Add participants by name, @handle, or email'
                  : 'Search name, @handle, or email'
              }
              className="w-full pl-9 pr-3 py-2 rounded-xl bg-[#F0F2F5] dark:bg-[#202C33] text-sm text-[#111B21] dark:text-[#E9EDEF] outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={lookupLoading || !searchQuery.trim()}
            className="px-3 py-2 rounded-xl bg-[#F0F2F5] dark:bg-[#202C33] hover:bg-[#E9EDEF] dark:hover:bg-[#2A3942] text-xs font-semibold text-[#111B21] dark:text-[#E9EDEF] shrink-0 cursor-pointer disabled:opacity-50"
          >
            {lookupLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Find'}
          </button>
        </form>

        {lookupError && (
          <div className="px-5 pb-2 text-xs text-red-600 dark:text-red-400">{lookupError}</div>
        )}

        {friendActionError && (
          <div
            role="alert"
            className="mx-5 mb-2 p-2.5 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-between gap-2 text-xs text-red-700 dark:text-red-300"
          >
            <span>{friendActionError}</span>
            <button
              type="button"
              onClick={() => setFriendActionError(null)}
              aria-label="Dismiss error"
              className="cursor-pointer shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {friendActionSuccess && (
          <div
            role="status"
            className="mx-5 mb-2 p-2.5 rounded-xl bg-[#00A884]/12 border border-[#00A884]/25 flex items-center justify-between gap-2 text-xs text-[#008069] dark:text-[#00A884]"
          >
            <span>{friendActionSuccess}</span>
            <button
              type="button"
              onClick={() => setFriendActionSuccess(null)}
              aria-label="Dismiss status"
              className="cursor-pointer shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto px-3 pb-3 divide-y divide-[#E9EDEF] dark:divide-[#222E35]">
          {exactMatch && (() => {
            const status = getFriendshipStatus(exactMatch.uid);
            return (
              <div
                key={exactMatch.uid}
                className="w-full flex items-center gap-3 p-2.5 rounded-xl hover:bg-[#F0F2F5] dark:hover:bg-[#202C33]"
              >
                <Avatar src={exactMatch.photoURL} name={exactMatch.displayName} isOnline={exactMatch.isOnline} />
                <div
                  className="flex-1 min-w-0 cursor-pointer"
                  onClick={async () => {
                    if (mode === 'group') {
                      toggleGroupMember(exactMatch);
                    } else if (status === 'friends') {
                      setBusy(true);
                      try {
                        await onStartDirectChat(exactMatch);
                        onClose();
                      } finally {
                        setBusy(false);
                      }
                    }
                  }}
                >
                  <div className="text-sm font-semibold text-[#111B21] dark:text-[#E9EDEF] truncate">
                    {exactMatch.displayName}
                  </div>
                  <div className="text-xs text-[#008069] dark:text-[#00A884] truncate">
                    @{exactMatch.username} · Exact match
                  </div>
                </div>

                {mode === 'group' ? (
                  <span
                    className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 cursor-pointer ${
                      selectedUids.includes(exactMatch.uid)
                        ? 'bg-[#00A884] border-[#00A884] text-white'
                        : 'border-[#8696A0]'
                    }`}
                    onClick={() => toggleGroupMember(exactMatch)}
                  >
                    {selectedUids.includes(exactMatch.uid) && <Check className="w-3.5 h-3.5" />}
                  </span>
                ) : (
                  renderDirectActions(exactMatch)
                )}
              </div>
            );
          })()}

          {filtered.length === 0 ? (
            <div className="py-10 px-4 text-center">
              <p className="text-sm text-[#54656F] dark:text-[#8696A0]">
                No discoverable contacts match your search yet.
              </p>
              <p className="text-xs text-[#667781] dark:text-[#8696A0] mt-1">
                Share the website link with friends or use Find above to add by @handle or email.
              </p>
            </div>
          ) : (
            filtered.map((person) => {
              const checked = selectedUids.includes(person.uid);
              const status = getFriendshipStatus(person.uid);

              return (
                <div
                  key={person.uid}
                  className="w-full flex items-center gap-3 p-2.5 hover:bg-[#F0F2F5] dark:hover:bg-[#202C33] rounded-xl transition-colors"
                >
                  <Avatar src={person.photoURL} name={person.displayName} isOnline={person.isOnline} />
                  <div
                    className="flex-1 min-w-0 cursor-pointer"
                    onClick={async () => {
                      if (mode === 'group') {
                        toggleGroupMember(person);
                      } else if (status === 'friends') {
                        setBusy(true);
                        try {
                          await onStartDirectChat(person);
                          onClose();
                        } finally {
                          setBusy(false);
                        }
                      }
                    }}
                  >
                    <div className="text-sm font-semibold text-[#111B21] dark:text-[#E9EDEF] truncate">
                      {person.displayName}
                    </div>
                    <div className="text-xs text-[#667781] dark:text-[#8696A0] truncate">
                      @{person.username} · {person.about}
                    </div>
                  </div>

                  {mode === 'group' ? (
                    <span
                      className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 cursor-pointer ${
                        checked
                          ? 'bg-[#00A884] border-[#00A884] text-white'
                          : 'border-[#8696A0]'
                      }`}
                      onClick={() => toggleGroupMember(person)}
                    >
                      {checked && <Check className="w-3.5 h-3.5" />}
                    </span>
                  ) : (
                    renderDirectActions(person)
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Share Website Invite Footer */}
        <div className="px-5 py-3 bg-[#F8FAFB] dark:bg-[#162127] border-t border-[#E9EDEF] dark:border-[#222E35] flex items-center justify-between gap-3">
          <span className="text-xs text-[#54656F] dark:text-[#8696A0] truncate">
            Your handle: <strong className="text-[#111B21] dark:text-[#E9EDEF]">@{publicProfile?.username}</strong>
          </span>
          <button
            type="button"
            onClick={handleCopyInvite}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white dark:bg-[#202C33] border border-[#D1D7DB] dark:border-[#2A3942] text-xs font-medium text-[#111B21] dark:text-[#E9EDEF] shrink-0 cursor-pointer"
          >
            {copiedUrl ? <Check className="w-3.5 h-3.5 text-[#00A884]" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedUrl ? 'Copied' : 'Copy invite'}
          </button>
        </div>
      </div>
    </div>
  );
}
