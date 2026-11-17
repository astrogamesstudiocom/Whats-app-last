import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  getRedirectResult,
  onAuthStateChanged,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut as firebaseSignOut,
  updateProfile as updateAuthProfile,
  type User,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  deleteDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  auth,
  db,
  googleProvider,
  handleFirestoreError,
  OperationType,
} from '../firebase';
import {
  BLUEPRINT_LIMITS,
  DESIGNATED_OWNER_EMAIL,
  PRIVACY_POLICY_VERSION,
  type AccountModerationRecord,
  type AdminRecord,
  type FriendRequest,
  type OwnerConfig,
  type PublicProfile,
  type UserPrivacyConsent,
  type UserPrivate,
  type WebsiteSettings,
} from '../types';
import { registerMessagingAndPermissions } from '../services/messaging';
import { uploadChatMedia } from '../services/media';
import {
  claimSuperAdminOwnership as claimSuperAdminOwnershipService,
  DEFAULT_WEBSITE_SETTINGS,
  logSystemActivity,
  submitPrivacyConsent,
} from '../services/moderation';

interface PendingProfileDraft {
  fullName: string;
  photoURL: string;
  email: string;
  acceptedPrivacyConsent?: boolean;
}

export type ActiveWebsiteSettings = Omit<WebsiteSettings, 'updatedBy' | 'updatedAt'> & {
  updatedBy?: string;
  updatedAt?: WebsiteSettings['updatedAt'];
};

interface AuthContextValue {
  firebaseUser: User | null;
  privateUser: UserPrivate | null;
  publicProfile: PublicProfile | null;
  ownerConfig: OwnerConfig | null;
  adminRecord: AdminRecord | null;
  privacyConsent: UserPrivacyConsent | null;
  privacyConsentChecked: boolean;
  needsPrivacyConsent: boolean;
  isSuperAdmin: boolean;
  isAdmin: boolean;
  ownerSetupRequired: boolean;
  accountModeration: AccountModerationRecord | null;
  websiteSettings: ActiveWebsiteSettings;
  loading: boolean;
  needsRegistration: boolean;
  needsEmailVerification: boolean;
  verificationSuccessEmail: string | null;
  justSignedInWelcome: boolean;
  googleSigningIn: boolean;
  popupBlocked: boolean;
  authError: string | null;
  friendRequests: FriendRequest[];
  friends: PublicProfile[];
  sendFriendRequest: (targetProfile: PublicProfile) => Promise<void>;
  acceptFriendRequest: (requestId: string) => Promise<void>;
  rejectFriendRequest: (requestId: string) => Promise<void>;
  cancelFriendRequest: (requestId: string) => Promise<void>;
  getFriendshipStatus: (targetUid: string) => 'friends' | 'pending_sent' | 'pending_received' | 'none';
  signInWithGoogle: () => Promise<void>;
  signInWithGoogleRedirect: () => Promise<void>;
  signUpWithEmail: (input: {
    fullName: string;
    email: string;
    password: string;
    avatarFile?: File | null;
    presetAvatarUrl?: string;
    acceptedPrivacyConsent?: boolean;
  }) => Promise<void>;
  signInWithEmail: (
    email: string,
    password: string
  ) => Promise<'signed-in' | 'unverified'>;
  checkEmailVerification: () => Promise<boolean>;
  resendVerificationEmail: () => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  clearVerificationSuccess: () => void;
  dismissWelcomeBanner: () => void;
  signOut: () => Promise<void>;
  checkUsernameAvailable: (username: string) => Promise<boolean>;
  completeRegistration: (input: {
    displayName: string;
    username: string;
    about: string;
    photoURL: string;
    isDiscoverable: boolean;
    acceptedPrivacyConsent?: boolean;
  }) => Promise<void>;
  acceptPrivacyPolicyConsent: () => Promise<void>;
  updateProfile: (input: {
    displayName: string;
    about: string;
    photoURL: string;
    isDiscoverable: boolean;
  }) => Promise<void>;
  enablePushNotifications: () => Promise<{ granted: boolean; tokenSaved: boolean }>;
  claimSuperAdminOwnership: () => Promise<void>;
  clearAuthError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function mapFirebaseAuthError(
  err: unknown,
  provider: 'google' | 'email' = 'email'
): string {
  const code = (err as { code?: string })?.code || '';
  const hostname =
    typeof window !== 'undefined' && window.location?.hostname
      ? window.location.hostname
      : 'this domain';

  switch (code) {
    case 'auth/email-already-in-use':
      return 'An account with this email address already exists. Please sign in instead.';
    case 'auth/invalid-email':
      return 'Please enter a valid email address.';
    case 'auth/weak-password':
      return 'Password must be at least 6 characters long.';
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'Invalid email address or password.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a moment and try again.';
    case 'auth/operation-not-allowed':
      return provider === 'google'
        ? 'Google Sign-In is not enabled in Firebase Console (Authentication -> Sign-in method -> Google). Please enable Google Sign-In in Firebase Console.'
        : 'Email/Password sign-in is not enabled in Firebase Authentication. Please use Continue with Google instead.';
    case 'auth/unauthorized-domain':
      return `Google Sign-In is blocked because "${hostname}" is not in Firebase Console -> Authentication -> Settings -> Authorized domains.`;
    case 'auth/popup-blocked':
      return 'Your browser blocked the Google Sign-In pop-up. Allow pop-ups for this site and try again.';
    case 'auth/account-exists-with-different-credential':
      return 'An account already exists with this email address using a different sign-in method.';
    case 'auth/user-disabled':
      return 'This account has been disabled. Please contact the website owner.';
    case 'auth/network-request-failed':
      return 'Network error while connecting to Google / Firebase Authentication. Please check your internet connection.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return '';
    default:
      return err instanceof Error ? err.message : 'Authentication failed. Please try again.';
  }
}

function savePendingDraft(uid: string, draft: PendingProfileDraft): void {
  try {
    localStorage.setItem(`verdechat_pending_${uid}`, JSON.stringify(draft));
  } catch {
    // Ignore storage issues
  }
}

function loadPendingDraft(uid: string): PendingProfileDraft | null {
  try {
    const raw = localStorage.getItem(`verdechat_pending_${uid}`);
    return raw ? (JSON.parse(raw) as PendingProfileDraft) : null;
  } catch {
    return null;
  }
}

function clearPendingDraft(uid: string): void {
  try {
    localStorage.removeItem(`verdechat_pending_${uid}`);
  } catch {
    // Ignore
  }
}

async function generateUniqueUsername(seedName: string, email: string, uid: string): Promise<string> {
  const rawBase = (email.split('@')[0] || seedName || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  const base = rawBase.length >= 3 ? rawBase.slice(0, 17) : `user_${uid.slice(0, 5).toLowerCase()}`;

  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate =
      attempt === 0
        ? base
        : `${base.slice(0, 16)}_${Math.floor(100 + Math.random() * 899)}`;
    const clean = candidate.slice(0, BLUEPRINT_LIMITS.USERNAME_MAX);
    if (!BLUEPRINT_LIMITS.USERNAME_PATTERN.test(clean)) continue;
    const snap = await getDoc(doc(db, 'usernames', clean));
    if (!snap.exists() || snap.data()?.uid === uid) {
      return clean;
    }
  }
  return `u_${uid.slice(0, 12).toLowerCase().replace(/[^a-z0-9_]/g, '')}`;
}

async function ensureVerifiedUserFirestoreProfile(user: User): Promise<void> {
  const privRef = doc(db, 'users', user.uid);
  const pubRef = doc(db, 'publicProfiles', user.uid);
  const [privSnap, pubSnap] = await Promise.all([getDoc(privRef), getDoc(pubRef)]);

  if (privSnap.exists() && pubSnap.exists()) {
    return;
  }

  const draft = loadPendingDraft(user.uid);
  const displayName = (
    draft?.fullName ||
    user.displayName ||
    user.email?.split('@')[0] ||
    'User'
  )
    .trim()
    .slice(0, BLUEPRINT_LIMITS.DISPLAY_NAME_MAX);
  const photoURL = (draft?.photoURL || user.photoURL || '').slice(0, BLUEPRINT_LIMITS.MEDIA_URL_MAX);
  const email = (draft?.email || user.email || '').slice(0, 320);
  const username = await generateUniqueUsername(displayName, email, user.uid);

  const batch = writeBatch(db);
  const usernameRef = doc(db, 'usernames', username);
  const existingUsernameSnap = await getDoc(usernameRef);
  if (!existingUsernameSnap.exists()) {
    batch.set(usernameRef, {
      uid: user.uid,
      username,
      createdAt: serverTimestamp(),
    });
  }

  if (!privSnap.exists()) {
    batch.set(privRef, {
      uid: user.uid,
      email,
      displayName,
      username,
      fcmTokens: [],
      notificationsEnabled: typeof Notification !== 'undefined' && Notification.permission === 'granted',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  if (!pubSnap.exists()) {
    batch.set(pubRef, {
      uid: user.uid,
      email: email.toLowerCase(),
      displayName,
      username,
      photoURL,
      about: 'Available on My Chat',
      isOnline: true,
      isDiscoverable: true,
      lastSeen: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  await batch.commit();

  if (draft?.acceptedPrivacyConsent) {
    try {
      await submitPrivacyConsent(user.uid, displayName);
    } catch {
      // User will be prompted by PrivacyConsentModal if needed
    }
  }

  clearPendingDraft(user.uid);
  void logSystemActivity({
    action: 'user_registered',
    actor: { uid: user.uid, name: displayName, role: 'user' },
    targetId: user.uid,
    targetLabel: `@${username}`,
    details: 'Verified email user completed account registration.',
  });
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [privateUser, setPrivateUser] = useState<UserPrivate | null>(null);
  const [publicProfile, setPublicProfile] = useState<PublicProfile | null>(null);
  const [ownerConfig, setOwnerConfig] = useState<OwnerConfig | null>(null);
  const [ownerConfigChecked, setOwnerConfigChecked] = useState(false);
  const [adminRecord, setAdminRecord] = useState<AdminRecord | null>(null);
  const [privacyConsent, setPrivacyConsent] = useState<UserPrivacyConsent | null>(null);
  const [privacyConsentChecked, setPrivacyConsentChecked] = useState(false);
  const [accountModeration, setAccountModeration] = useState<AccountModerationRecord | null>(null);
  const [websiteSettings, setWebsiteSettings] =
    useState<ActiveWebsiteSettings>(DEFAULT_WEBSITE_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [needsRegistration, setNeedsRegistration] = useState(false);
  const [needsEmailVerification, setNeedsEmailVerification] = useState(false);
  const [verificationSuccessEmail, setVerificationSuccessEmail] = useState<string | null>(null);
  const [justSignedInWelcome, setJustSignedInWelcome] = useState(false);
  const [googleSigningIn, setGoogleSigningIn] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Handle redirect-based Google sign-in results (e.g. if user fell back to redirect on mobile)
  useEffect(() => {
    void getRedirectResult(auth)
      .then((res) => {
        if (res?.user) {
          setJustSignedInWelcome(true);
        }
      })
      .catch((err) => {
        const message = mapFirebaseAuthError(err);
        if (message) setAuthError(message);
      });
  }, []);

  // Global website settings subscription (public read-only config)
  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, 'websiteSettings', 'global'),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as WebsiteSettings;
          setWebsiteSettings({
            ...DEFAULT_WEBSITE_SETTINGS,
            ...data,
          });
        } else {
          setWebsiteSettings(DEFAULT_WEBSITE_SETTINGS);
        }
      },
      () => {
        // Keep defaults if settings doc not yet created
      }
    );
    return () => unsub();
  }, []);

  useEffect(() => {
    let unsubPrivate: (() => void) | null = null;
    let unsubPublic: (() => void) | null = null;
    let unsubAdmin: (() => void) | null = null;
    let unsubModeration: (() => void) | null = null;
    let unsubConsent: (() => void) | null = null;

    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      if (unsubPrivate) {
        unsubPrivate();
        unsubPrivate = null;
      }
      if (unsubPublic) {
        unsubPublic();
        unsubPublic = null;
      }
      if (unsubAdmin) {
        unsubAdmin();
        unsubAdmin = null;
      }
      if (unsubModeration) {
        unsubModeration();
        unsubModeration = null;
      }
      if (unsubConsent) {
        unsubConsent();
        unsubConsent = null;
      }

      setFirebaseUser(user);

      if (!user) {
        setPrivateUser(null);
        setPublicProfile(null);
        setOwnerConfig(null);
        setOwnerConfigChecked(false);
        setAdminRecord(null);
        setPrivacyConsent(null);
        setPrivacyConsentChecked(false);
        setAccountModeration(null);
        setNeedsRegistration(false);
        setNeedsEmailVerification(false);
        setLoading(false);
        return;
      }

      // Enforce real Firebase email verification before allowing dashboard access
      if (!user.emailVerified) {
        setPrivateUser(null);
        setPublicProfile(null);
        setOwnerConfig(null);
        setOwnerConfigChecked(false);
        setAdminRecord(null);
        setPrivacyConsent(null);
        setPrivacyConsentChecked(false);
        setAccountModeration(null);
        setNeedsRegistration(false);
        setNeedsEmailVerification(true);
        setLoading(false);
        return;
      }

      setNeedsEmailVerification(false);
      setPrivacyConsentChecked(false);
      setLoading(true);
      const userDocPath = `users/${user.uid}`;
      const pubDocPath = `publicProfiles/${user.uid}`;

      try {
        // Refresh token best-effort so verified email claims propagate without failing offline
        await user.getIdToken(true).catch(() => {});

        const [privSnap, pubSnap, modSnap] = await Promise.all([
          getDoc(doc(db, 'users', user.uid)),
          getDoc(doc(db, 'publicProfiles', user.uid)),
          getDoc(doc(db, 'accountModeration', user.uid)).catch(() => null),
        ]);

        const isRestrictedNow =
          Boolean(modSnap?.exists()) &&
          ['suspended', 'blocked', 'removed'].includes(
            String((modSnap?.data() as AccountModerationRecord | undefined)?.status || 'active')
          );

        if (modSnap?.exists()) {
          setAccountModeration(modSnap.data() as AccountModerationRecord);
        } else {
          setAccountModeration(null);
        }

        // If user came from email/password verification flow with a saved draft, auto-create Firestore profile
        const hasPendingDraft = Boolean(loadPendingDraft(user.uid));
        if ((!privSnap.exists() || !pubSnap.exists()) && hasPendingDraft && !isRestrictedNow) {
          await ensureVerifiedUserFirestoreProfile(user);
        } else if (!privSnap.exists() || !pubSnap.exists()) {
          setNeedsRegistration(!isRestrictedNow);
          setPrivateUser(privSnap.exists() ? (privSnap.data() as UserPrivate) : null);
          setPublicProfile(pubSnap.exists() ? (pubSnap.data() as PublicProfile) : null);
          setLoading(false);
        } else {
          setNeedsRegistration(false);
          if (!isRestrictedNow) {
            const existingEmail = (pubSnap.data()?.email as string | undefined) || '';
            const normalizedAuthEmail = (user.email || '').trim().toLowerCase().slice(0, 320);
            const presencePatch: Record<string, unknown> = {
              isOnline: true,
              lastSeen: serverTimestamp(),
              updatedAt: serverTimestamp(),
            };
            if (!existingEmail && normalizedAuthEmail) {
              presencePatch.email = normalizedAuthEmail;
            }
            void updateDoc(doc(db, 'publicProfiles', user.uid), presencePatch).catch(() => {});
          }
        }

        unsubPrivate = onSnapshot(
          doc(db, 'users', user.uid),
          (snap) => {
            if (snap.exists()) {
              setPrivateUser(snap.data() as UserPrivate);
            }
          },
          (err) => {
            if (auth.currentUser) {
              handleFirestoreError(err, OperationType.GET, userDocPath);
            }
          }
        );

        unsubPublic = onSnapshot(
          doc(db, 'publicProfiles', user.uid),
          (snap) => {
            if (snap.exists()) {
              setPublicProfile(snap.data() as PublicProfile);
              setNeedsRegistration(false);
            }
            setLoading(false);
          },
          (err) => {
            if (auth.currentUser) {
              handleFirestoreError(err, OperationType.GET, pubDocPath);
            }
          }
        );

        unsubAdmin = onSnapshot(
          doc(db, 'admins', user.uid),
          (snap) => {
            if (snap.exists()) {
              setAdminRecord(snap.data() as AdminRecord);
            } else {
              setAdminRecord(null);
            }
          },
          () => {
            setAdminRecord(null);
          }
        );

        unsubModeration = onSnapshot(
          doc(db, 'accountModeration', user.uid),
          (snap) => {
            if (snap.exists()) {
              setAccountModeration(snap.data() as AccountModerationRecord);
            } else {
              setAccountModeration(null);
            }
          },
          () => {
            setAccountModeration(null);
          }
        );

        unsubConsent = onSnapshot(
          doc(db, 'userPrivacyConsents', user.uid),
          (snap) => {
            setPrivacyConsent(snap.exists() ? (snap.data() as UserPrivacyConsent) : null);
            setPrivacyConsentChecked(true);
          },
          () => {
            setPrivacyConsent(null);
            setPrivacyConsentChecked(true);
          }
        );
      } catch (err) {
        console.error('Failed to initialize authenticated user session:', err);
        setAuthError(
          err instanceof Error
            ? err.message
            : 'Unable to load your VerdeChat profile. Please try signing in again.'
        );
        setLoading(false);
      }
    });

    return () => {
      unsubAuth();
      if (unsubPrivate) unsubPrivate();
      if (unsubPublic) unsubPublic();
      if (unsubAdmin) unsubAdmin();
      if (unsubModeration) unsubModeration();
      if (unsubConsent) unsubConsent();
    };
  }, []);

  // Strictly only designated owner email subscribes to systemConfig/owner
  const isDesignatedOwnerEmail =
    Boolean(firebaseUser?.emailVerified) &&
    (firebaseUser?.email || '').toLowerCase() === DESIGNATED_OWNER_EMAIL;

  useEffect(() => {
    if (!firebaseUser || !firebaseUser.emailVerified || !isDesignatedOwnerEmail) {
      setOwnerConfig(null);
      setOwnerConfigChecked(false);
      return;
    }

    const unsub = onSnapshot(
      doc(db, 'systemConfig', 'owner'),
      (snap) => {
        setOwnerConfig(snap.exists() ? (snap.data() as OwnerConfig) : null);
        setOwnerConfigChecked(true);
      },
      () => {
        setOwnerConfig(null);
        setOwnerConfigChecked(true);
      }
    );

    return () => unsub();
  }, [firebaseUser, isDesignatedOwnerEmail]);

  const isSuperAdmin = Boolean(
    firebaseUser?.emailVerified &&
      isDesignatedOwnerEmail &&
      (!ownerConfig || ownerConfig.ownerUid === firebaseUser.uid)
  );

  // Owner Dashboard is strictly Owner-only (fezinfezin42@gmail.com)
  const isAdmin = isSuperAdmin;

  const ownerSetupRequired = Boolean(
    isDesignatedOwnerEmail &&
      ownerConfigChecked &&
      !ownerConfig &&
      !needsRegistration &&
      Boolean(publicProfile)
  );

  const isAccountRestricted = Boolean(
    accountModeration &&
      ['suspended', 'blocked', 'removed'].includes(accountModeration.status)
  );

  const needsPrivacyConsent = Boolean(
    firebaseUser?.emailVerified &&
      publicProfile &&
      !isAccountRestricted &&
      privacyConsentChecked &&
      (!privacyConsent ||
        !privacyConsent.consented ||
        privacyConsent.policyVersion !== PRIVACY_POLICY_VERSION)
  );

  // Presence lifecycle
  useEffect(() => {
    if (!firebaseUser || !firebaseUser.emailVerified || needsRegistration || isAccountRestricted) {
      return;
    }

    const setPresence = (online: boolean) => {
      if (!auth.currentUser || !auth.currentUser.emailVerified) return;
      void updateDoc(doc(db, 'publicProfiles', firebaseUser.uid), {
        isOnline: online,
        lastSeen: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }).catch(() => {});
    };

    const handleVisibility = () => {
      setPresence(document.visibilityState === 'visible');
    };

    const handleUnload = () => {
      setPresence(false);
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('beforeunload', handleUnload);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('beforeunload', handleUnload);
    };
  }, [firebaseUser, needsRegistration, isAccountRestricted]);

  const signInWithGoogle = async () => {
    if (googleSigningIn) return;
    setAuthError(null);
    setPopupBlocked(false);
    setVerificationSuccessEmail(null);
    setGoogleSigningIn(true);
    try {
      await signInWithPopup(auth, googleProvider);
      setJustSignedInWelcome(true);
    } catch (err) {
      const code = (err as { code?: string })?.code || '';
      if (code === 'auth/popup-blocked') {
        setPopupBlocked(true);
      }
      const message = mapFirebaseAuthError(err, 'google');
      if (message) setAuthError(message);
    } finally {
      setGoogleSigningIn(false);
    }
  };

  const signInWithGoogleRedirect = async () => {
    if (googleSigningIn) return;
    setAuthError(null);
    setPopupBlocked(false);
    setVerificationSuccessEmail(null);
    setGoogleSigningIn(true);
    try {
      await signInWithRedirect(auth, googleProvider);
    } catch (err) {
      const message = mapFirebaseAuthError(err, 'google');
      if (message) setAuthError(message);
      setGoogleSigningIn(false);
    }
  };

  const signUpWithEmail = async (input: {
    fullName: string;
    email: string;
    password: string;
    avatarFile?: File | null;
    presetAvatarUrl?: string;
    acceptedPrivacyConsent?: boolean;
  }) => {
    setAuthError(null);
    setVerificationSuccessEmail(null);
    const cleanName = input.fullName.trim().slice(0, BLUEPRINT_LIMITS.DISPLAY_NAME_MAX);
    const cleanEmail = input.email.trim();

    if (
      !websiteSettings.allowNewRegistrations &&
      cleanEmail.toLowerCase() !== DESIGNATED_OWNER_EMAIL
    ) {
      const msg = 'New account registrations are currently paused by the website administrator.';
      setAuthError(msg);
      throw new Error(msg);
    }

    try {
      const cred = await createUserWithEmailAndPassword(auth, cleanEmail, input.password);
      let finalPhotoUrl = input.presetAvatarUrl || '';

      if (input.avatarFile) {
        try {
          const uploaded = await uploadChatMedia(
            input.avatarFile,
            `avatars/${cred.user.uid}`,
            input.avatarFile.name
          );
          finalPhotoUrl = uploaded.url;
        } catch (uploadErr) {
          console.warn('Avatar upload skipped during signup:', uploadErr);
        }
      }

      await updateAuthProfile(cred.user, {
        displayName: cleanName,
        photoURL: finalPhotoUrl || null,
      });

      savePendingDraft(cred.user.uid, {
        fullName: cleanName,
        photoURL: finalPhotoUrl,
        email: cleanEmail,
        acceptedPrivacyConsent: Boolean(input.acceptedPrivacyConsent),
      });

      await sendEmailVerification(cred.user, {
        url: window.location.origin,
      });

      setNeedsEmailVerification(true);
    } catch (err) {
      const msg = mapFirebaseAuthError(err) || 'Could not create account.';
      setAuthError(msg);
      throw new Error(msg);
    }
  };

  const signInWithEmail = async (
    email: string,
    password: string
  ): Promise<'signed-in' | 'unverified'> => {
    setAuthError(null);
    setVerificationSuccessEmail(null);
    try {
      const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
      await reload(cred.user);

      if (!cred.user.emailVerified) {
        setNeedsEmailVerification(true);
        return 'unverified';
      }

      await cred.user.getIdToken(true);
      await ensureVerifiedUserFirestoreProfile(cred.user);
      setNeedsEmailVerification(false);
      setJustSignedInWelcome(true);
      return 'signed-in';
    } catch (err) {
      const msg = mapFirebaseAuthError(err) || 'Could not sign in.';
      setAuthError(msg);
      throw new Error(msg);
    }
  };

  const checkEmailVerification = async (): Promise<boolean> => {
    const user = auth.currentUser;
    if (!user) return false;
    setAuthError(null);

    await reload(user);
    if (!user.emailVerified) {
      return false;
    }

    await user.getIdToken(true);
    await ensureVerifiedUserFirestoreProfile(user);

    const verifiedEmail = user.email || '';
    await firebaseSignOut(auth);
    setNeedsEmailVerification(false);
    setVerificationSuccessEmail(verifiedEmail);
    return true;
  };

  const resendVerificationEmail = async () => {
    const user = auth.currentUser;
    if (!user) {
      throw new Error('No active registration session found. Please sign in first.');
    }
    setAuthError(null);
    try {
      await sendEmailVerification(user, {
        url: window.location.origin,
      });
    } catch (err) {
      const msg = mapFirebaseAuthError(err) || 'Could not resend verification email.';
      throw new Error(msg);
    }
  };

  const sendPasswordReset = async (email: string) => {
    setAuthError(null);
    try {
      await sendPasswordResetEmail(auth, email.trim(), {
        url: window.location.origin,
      });
    } catch (err) {
      const msg = mapFirebaseAuthError(err) || 'Could not send password reset email.';
      throw new Error(msg);
    }
  };

  const signOut = async () => {
    if (firebaseUser && firebaseUser.emailVerified && !needsRegistration) {
      try {
        await updateDoc(doc(db, 'publicProfiles', firebaseUser.uid), {
          isOnline: false,
          lastSeen: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch {
        // Best-effort offline mark
      }
    }
    setJustSignedInWelcome(false);
    setNeedsEmailVerification(false);
    await firebaseSignOut(auth);
  };

  const checkUsernameAvailable = async (rawUsername: string): Promise<boolean> => {
    const clean = rawUsername.trim().toLowerCase();
    if (!BLUEPRINT_LIMITS.USERNAME_PATTERN.test(clean)) {
      return false;
    }
    try {
      const snap = await getDoc(doc(db, 'usernames', clean));
      if (!snap.exists()) return true;
      return snap.data()?.uid === firebaseUser?.uid;
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, `usernames/${clean}`);
    }
  };

  const completeRegistration = async (input: {
    displayName: string;
    username: string;
    about: string;
    photoURL: string;
    isDiscoverable: boolean;
    acceptedPrivacyConsent?: boolean;
  }) => {
    if (!firebaseUser) throw new Error('Not authenticated');

    if (
      !websiteSettings.allowNewRegistrations &&
      (firebaseUser.email || '').toLowerCase() !== DESIGNATED_OWNER_EMAIL
    ) {
      throw new Error(
        'New account registrations are currently paused by the website administrator.'
      );
    }

    const cleanName = input.displayName.trim().slice(0, BLUEPRINT_LIMITS.DISPLAY_NAME_MAX);
    const cleanUsername = input.username.trim().toLowerCase();
    const cleanAbout = input.about.trim().slice(0, BLUEPRINT_LIMITS.ABOUT_MAX);
    const cleanPhoto = (input.photoURL || firebaseUser.photoURL || '').slice(
      0,
      BLUEPRINT_LIMITS.MEDIA_URL_MAX
    );

    if (!cleanName) throw new Error('Display name is required.');
    if (!BLUEPRINT_LIMITS.USERNAME_PATTERN.test(cleanUsername)) {
      throw new Error('Username must be 3-24 lowercase letters, numbers, or underscores.');
    }

    const available = await checkUsernameAvailable(cleanUsername);
    if (!available) {
      throw new Error('That @username is already taken. Please pick another.');
    }

    const batch = writeBatch(db);
    const usernameRef = doc(db, 'usernames', cleanUsername);
    const existingUsernameSnap = await getDoc(usernameRef);
    if (!existingUsernameSnap.exists()) {
      batch.set(usernameRef, {
        uid: firebaseUser.uid,
        username: cleanUsername,
        createdAt: serverTimestamp(),
      });
    }

    batch.set(doc(db, 'users', firebaseUser.uid), {
      uid: firebaseUser.uid,
      email: (firebaseUser.email || '').slice(0, 320),
      displayName: cleanName,
      username: cleanUsername,
      fcmTokens: [],
      notificationsEnabled:
        typeof Notification !== 'undefined' && Notification.permission === 'granted',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    batch.set(doc(db, 'publicProfiles', firebaseUser.uid), {
      uid: firebaseUser.uid,
      email: (firebaseUser.email || '').trim().toLowerCase().slice(0, 320),
      displayName: cleanName,
      username: cleanUsername,
      photoURL: cleanPhoto,
      about: cleanAbout || 'Available on My Chat',
      isOnline: true,
      isDiscoverable: input.isDiscoverable,
      lastSeen: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    try {
      await batch.commit();
      if (input.acceptedPrivacyConsent) {
        try {
          await submitPrivacyConsent(firebaseUser.uid, cleanName);
        } catch {
          // Will show PrivacyConsentModal if consent write needs retry
        }
      }
      setNeedsRegistration(false);
      setJustSignedInWelcome(true);
      void logSystemActivity({
        action: 'user_registered',
        actor: { uid: firebaseUser.uid, name: cleanName, role: 'user' },
        targetId: firebaseUser.uid,
        targetLabel: `@${cleanUsername}`,
        details: 'New user completed profile setup.',
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `users/${firebaseUser.uid}`);
    }
  };

  const acceptPrivacyPolicyConsent = async () => {
    if (!firebaseUser) {
      throw new Error('You must be signed in to accept the privacy policy.');
    }
    const name = publicProfile?.displayName || firebaseUser.displayName || 'User';
    await submitPrivacyConsent(firebaseUser.uid, name);
  };

  const updateProfile = async (input: {
    displayName: string;
    about: string;
    photoURL: string;
    isDiscoverable: boolean;
  }) => {
    if (!firebaseUser || !publicProfile || !privateUser) return;

    const cleanName = input.displayName.trim().slice(0, BLUEPRINT_LIMITS.DISPLAY_NAME_MAX);
    const cleanAbout = input.about.trim().slice(0, BLUEPRINT_LIMITS.ABOUT_MAX);
    const cleanPhoto = input.photoURL.slice(0, BLUEPRINT_LIMITS.MEDIA_URL_MAX);

    if (!cleanName) throw new Error('Display name cannot be empty.');

    const batch = writeBatch(db);
    batch.update(doc(db, 'publicProfiles', firebaseUser.uid), {
      displayName: cleanName,
      username: publicProfile.username,
      photoURL: cleanPhoto,
      about: cleanAbout,
      isDiscoverable: input.isDiscoverable,
      updatedAt: serverTimestamp(),
    });
    batch.update(doc(db, 'users', firebaseUser.uid), {
      displayName: cleanName,
      username: privateUser.username,
      updatedAt: serverTimestamp(),
    });

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `publicProfiles/${firebaseUser.uid}`);
    }
  };

  const enablePushNotifications = async () => {
    if (!firebaseUser || !privateUser) {
      return { granted: false, tokenSaved: false };
    }
    const res = await registerMessagingAndPermissions();
    const granted = res.permission === 'granted';
    let tokenSaved = false;

    if (granted) {
      const existingTokens = Array.isArray(privateUser.fcmTokens) ? privateUser.fcmTokens : [];
      const nextTokens =
        res.fcmToken && !existingTokens.includes(res.fcmToken)
          ? [...existingTokens, res.fcmToken].slice(-10)
          : existingTokens;

      try {
        await setDoc(
          doc(db, 'users', firebaseUser.uid),
          {
            ...privateUser,
            fcmTokens: nextTokens,
            notificationsEnabled: true,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
        tokenSaved = Boolean(res.fcmToken);
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${firebaseUser.uid}`);
      }
    }

    return { granted, tokenSaved };
  };

  const claimSuperAdminOwnership = async () => {
    if (!firebaseUser) {
      throw new Error('You must be signed in.');
    }
    await claimSuperAdminOwnershipService(
      firebaseUser,
      publicProfile?.displayName || firebaseUser.displayName || 'Website Owner'
    );
  };

  const [friendRequests, setFriendRequests] = useState<FriendRequest[]>([]);
  const [friends, setFriends] = useState<PublicProfile[]>([]);

  useEffect(() => {
    if (!firebaseUser || !publicProfile) {
      setFriendRequests([]);
      return;
    }

    const qSender = query(collection(db, 'friendRequests'), where('senderUid', '==', firebaseUser.uid));
    const qReceiver = query(collection(db, 'friendRequests'), where('receiverUid', '==', firebaseUser.uid));

    const map1 = new Map<string, FriendRequest>();
    const map2 = new Map<string, FriendRequest>();

    const normalizeFriendRequestDoc = (
      id: string,
      raw: Record<string, unknown>
    ): FriendRequest => {
      const senderUid = String(raw.senderUid || raw.senderId || '');
      const receiverUid = String(raw.receiverUid || raw.receiverId || '');
      return {
        ...(raw as Omit<FriendRequest, 'id'>),
        id,
        senderId: String(raw.senderId || senderUid),
        senderUid,
        senderEmail: String(raw.senderEmail || ''),
        senderName: String(raw.senderName || 'VerdeChat User'),
        senderPhoto: String(raw.senderPhoto || ''),
        senderUsername: String(raw.senderUsername || ''),
        receiverId: String(raw.receiverId || receiverUid),
        receiverUid,
        receiverEmail: String(raw.receiverEmail || ''),
        receiverName: String(raw.receiverName || 'VerdeChat User'),
        receiverPhoto: String(raw.receiverPhoto || ''),
        receiverUsername: String(raw.receiverUsername || ''),
      };
    };

    const updateAll = () => {
      const merged = new Map<string, FriendRequest>();
      map1.forEach((v, k) => merged.set(k, v));
      map2.forEach((v, k) => merged.set(k, v));
      const arr = Array.from(merged.values());
      arr.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
      setFriendRequests(arr);
    };

    const unsub1 = onSnapshot(
      qSender,
      (snap) => {
        map1.clear();
        snap.docs.forEach((d) =>
          map1.set(d.id, normalizeFriendRequestDoc(d.id, d.data() as Record<string, unknown>))
        );
        updateAll();
      },
      (err) => {
        console.error('[FriendRequests] Sent requests subscription error:', err);
      }
    );

    const unsub2 = onSnapshot(
      qReceiver,
      (snap) => {
        map2.clear();
        snap.docs.forEach((d) =>
          map2.set(d.id, normalizeFriendRequestDoc(d.id, d.data() as Record<string, unknown>))
        );
        updateAll();
      },
      (err) => {
        console.error('[FriendRequests] Incoming requests subscription error:', err);
      }
    );

    return () => {
      unsub1();
      unsub2();
    };
  }, [firebaseUser, publicProfile]);

  useEffect(() => {
    if (!firebaseUser || !publicProfile) {
      setFriends([]);
      return;
    }
    const acceptedUids = new Set<string>();
    friendRequests.forEach((req) => {
      if (req.status === 'accepted') {
        const peerUid = req.senderUid === firebaseUser.uid ? req.receiverUid : req.senderUid;
        if (peerUid) acceptedUids.add(peerUid);
      }
    });

    if (acceptedUids.size === 0) {
      setFriends([]);
      return;
    }

    let active = true;
    Promise.all(
      Array.from(acceptedUids).map(async (uid) => {
        try {
          const snap = await getDoc(doc(db, 'publicProfiles', uid));
          if (snap.exists()) {
            return snap.data() as PublicProfile;
          }
        } catch (err) {
          console.error(`[FriendRequests] Failed to load friend profile ${uid}:`, err);
        }
        return null;
      })
    ).then((results) => {
      if (!active) return;
      const valid = results.filter((p): p is PublicProfile => Boolean(p));
      setFriends(valid);
    });

    return () => {
      active = false;
    };
  }, [friendRequests, firebaseUser, publicProfile]);

  const sendFriendRequest = async (targetProfile: PublicProfile) => {
    if (!firebaseUser || !publicProfile) {
      const authErr = new Error('You must be signed in to send a friend request.');
      console.error('[FriendRequests] Cannot send request:', authErr.message);
      throw authErr;
    }
    if (!targetProfile?.uid) {
      const targetErr = new Error('Target user profile is missing a valid user ID.');
      console.error('[FriendRequests] Cannot send request:', targetErr.message);
      throw targetErr;
    }
    if (targetProfile.uid === firebaseUser.uid) {
      const selfErr = new Error('Cannot send a friend request to yourself.');
      console.error('[FriendRequests] Cannot send request:', selfErr.message);
      throw selfErr;
    }

    const requestId = `req_${[firebaseUser.uid, targetProfile.uid].sort().join('_')}`;
    const reqRef = doc(db, 'friendRequests', requestId);

    const senderEmail = (firebaseUser.email || publicProfile.email || '')
      .trim()
      .toLowerCase()
      .slice(0, 320);
    const receiverEmail = (targetProfile.email || '')
      .trim()
      .toLowerCase()
      .slice(0, 320);
    const senderName =
      (publicProfile.displayName || firebaseUser.displayName || 'VerdeChat User')
        .trim()
        .slice(0, BLUEPRINT_LIMITS.DISPLAY_NAME_MAX) || 'VerdeChat User';
    const receiverName =
      (targetProfile.displayName || 'VerdeChat User')
        .trim()
        .slice(0, BLUEPRINT_LIMITS.DISPLAY_NAME_MAX) || 'VerdeChat User';

    const payload = {
      id: requestId,
      senderId: firebaseUser.uid,
      senderUid: firebaseUser.uid,
      senderEmail,
      senderName,
      senderPhoto: (publicProfile.photoURL || firebaseUser.photoURL || '').slice(
        0,
        BLUEPRINT_LIMITS.MEDIA_URL_MAX
      ),
      senderUsername: (publicProfile.username || '')
        .trim()
        .toLowerCase()
        .slice(0, BLUEPRINT_LIMITS.USERNAME_MAX),
      receiverId: targetProfile.uid,
      receiverUid: targetProfile.uid,
      receiverEmail,
      receiverName,
      receiverPhoto: (targetProfile.photoURL || '').slice(0, BLUEPRINT_LIMITS.MEDIA_URL_MAX),
      receiverUsername: (targetProfile.username || '')
        .trim()
        .toLowerCase()
        .slice(0, BLUEPRINT_LIMITS.USERNAME_MAX),
      status: 'pending' as const,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    console.info('[FriendRequests] Sending friend request:', {
      requestId,
      senderId: payload.senderId,
      senderEmail: payload.senderEmail,
      receiverId: payload.receiverId,
      receiverEmail: payload.receiverEmail,
      status: payload.status,
    });

    try {
      const existingSnap = await getDoc(reqRef);
      if (existingSnap.exists()) {
        const existingData = existingSnap.data();
        const existingStatus = existingData?.status;
        if (existingStatus === 'rejected') {
          console.info('[FriendRequests] Removing previous rejected request before resending:', requestId);
          await deleteDoc(reqRef);
        } else if (existingStatus === 'pending') {
          console.info('[FriendRequests] Request already pending:', requestId);
          return;
        } else if (existingStatus === 'accepted') {
          console.info('[FriendRequests] Users are already friends:', requestId);
          return;
        }
      }

      await setDoc(reqRef, payload);
      console.info('[FriendRequests] Friend request saved to Firestore:', requestId);
    } catch (err) {
      console.error('[FriendRequests] Failed to save friend request to Firestore:', {
        requestId,
        error: err,
      });
      handleFirestoreError(err, OperationType.WRITE, `friendRequests/${requestId}`);
    }
  };

  const acceptFriendRequest = async (requestId: string) => {
    if (!firebaseUser) throw new Error('Not signed in');
    const reqRef = doc(db, 'friendRequests', requestId);
    try {
      await updateDoc(reqRef, {
        status: 'accepted',
        updatedAt: serverTimestamp(),
      });
      console.info('[FriendRequests] Accepted friend request:', requestId);
    } catch (err) {
      console.error('[FriendRequests] Failed to accept friend request:', { requestId, error: err });
      handleFirestoreError(err, OperationType.UPDATE, `friendRequests/${requestId}`);
    }
  };

  const rejectFriendRequest = async (requestId: string) => {
    if (!firebaseUser) throw new Error('Not signed in');
    const reqRef = doc(db, 'friendRequests', requestId);
    try {
      await updateDoc(reqRef, {
        status: 'rejected',
        updatedAt: serverTimestamp(),
      });
      console.info('[FriendRequests] Rejected friend request:', requestId);
    } catch (err) {
      console.error('[FriendRequests] Failed to reject friend request:', { requestId, error: err });
      handleFirestoreError(err, OperationType.UPDATE, `friendRequests/${requestId}`);
    }
  };

  const cancelFriendRequest = async (requestId: string) => {
    if (!firebaseUser) throw new Error('Not signed in');
    const reqRef = doc(db, 'friendRequests', requestId);
    try {
      const snap = await getDoc(reqRef);
      if (
        snap.exists() &&
        (snap.data().senderUid === firebaseUser.uid ||
          snap.data().receiverUid === firebaseUser.uid)
      ) {
        await deleteDoc(reqRef);
        console.info('[FriendRequests] Cancelled/deleted friend request:', requestId);
      }
    } catch (err) {
      console.error('[FriendRequests] Failed to cancel friend request:', { requestId, error: err });
      handleFirestoreError(err, OperationType.DELETE, `friendRequests/${requestId}`);
    }
  };

  const getFriendshipStatus = (targetUid: string): 'friends' | 'pending_sent' | 'pending_received' | 'none' => {
    if (!firebaseUser || targetUid === firebaseUser.uid) return 'friends';
    const req = friendRequests.find(
      (r) => r.senderUid === targetUid || r.receiverUid === targetUid
    );
    if (!req) return 'none';
    if (req.status === 'accepted') return 'friends';
    if (req.status === 'pending') {
      return req.senderUid === firebaseUser.uid ? 'pending_sent' : 'pending_received';
    }
    return 'none';
  };

  return (
    <AuthContext.Provider
      value={{
        firebaseUser,
        privateUser,
        publicProfile,
        ownerConfig,
        adminRecord,
        privacyConsent,
        privacyConsentChecked,
        needsPrivacyConsent,
        isSuperAdmin,
        isAdmin,
        ownerSetupRequired,
        accountModeration,
        websiteSettings,
        loading,
        needsRegistration,
        needsEmailVerification,
        verificationSuccessEmail,
        justSignedInWelcome,
        googleSigningIn,
        popupBlocked,
        authError,
        friendRequests,
        friends,
        sendFriendRequest,
        acceptFriendRequest,
        rejectFriendRequest,
        cancelFriendRequest,
        getFriendshipStatus,
        signInWithGoogle,
        signInWithGoogleRedirect,
        signUpWithEmail,
        signInWithEmail,
        checkEmailVerification,
        resendVerificationEmail,
        sendPasswordReset,
        clearVerificationSuccess: () => setVerificationSuccessEmail(null),
        dismissWelcomeBanner: () => setJustSignedInWelcome(false),
        signOut,
        checkUsernameAvailable,
        completeRegistration,
        acceptPrivacyPolicyConsent,
        updateProfile,
        enablePushNotifications,
        claimSuperAdminOwnership,
        clearAuthError: () => {
          setAuthError(null);
          setPopupBlocked(false);
        },
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
