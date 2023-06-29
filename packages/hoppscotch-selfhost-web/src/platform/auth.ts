import axios from "axios"
import {
  AuthEvent,
  AuthPlatformDef,
  HoppUser,
} from "@hoppscotch/common/platform/auth"
import { BehaviorSubject, Subject } from "rxjs"
import {
  getLocalConfig,
  removeLocalConfig,
  setLocalConfig,
} from "@hoppscotch/common/newstore/localpersistence"
import { Ref, ref, watch } from "vue"

export const authEvents$ = new Subject<AuthEvent | { event: "token_refresh" }>()
const currentUser$ = new BehaviorSubject<HoppUser | null>(null)
export const probableUser$ = new BehaviorSubject<HoppUser | null>(null)

async function logout() {
  await axios.get(`${import.meta.env.VITE_BACKEND_API_URL}/auth/logout`, {
    withCredentials: true,
  })
}

async function signInUserWithGithubFB() {
  window.location.href = `${import.meta.env.VITE_BACKEND_API_URL}/auth/github`
}

async function signInUserWithGoogleFB() {
  window.location.href = `${import.meta.env.VITE_BACKEND_API_URL}/auth/google`
}

async function signInUserWithMicrosoftFB() {
  window.location.href = `${
    import.meta.env.VITE_BACKEND_API_URL
  }/auth/microsoft`
}

async function getInitialUserDetails() {
  const res = await axios.post<{
    data?: {
      me?: {
        uid: string
        displayName: string
        email: string
        photoURL: string
        isAdmin: boolean
        createdOn: string
        // emailVerified: boolean
      }
    }
    errors?: Array<{
      message: string
    }>
  }>(
    `${import.meta.env.VITE_BACKEND_GQL_URL}`,
    {
      query: `query Me {
      me {
        uid
        displayName
        email
        photoURL
        isAdmin
        createdOn
      }
    }`,
    },
    {
      headers: {
        "Content-Type": "application/json",
      },
      withCredentials: true,
    }
  )

  return res.data
}

const isGettingInitialUser: Ref<null | boolean> = ref(null)

function setUser(user: HoppUser | null) {
  currentUser$.next(user)
  probableUser$.next(user)

  setLocalConfig("login_state", JSON.stringify(user))
}

async function setInitialUser() {
  isGettingInitialUser.value = true
  const res = await getInitialUserDetails()

  const error = res.errors && res.errors[0]

  // no cookies sent. so the user is not logged in
  if (error && error.message === "auth/cookies_not_found") {
    setUser(null)
    isGettingInitialUser.value = false
    return
  }

  if (error && error.message === "user/not_found") {
    setUser(null)
    isGettingInitialUser.value = false
    return
  }

  // cookies sent, but it is expired, we need to refresh the token
  if (error && error.message === "Unauthorized") {
    const isRefreshSuccess = await refreshToken()

    if (isRefreshSuccess) {
      setInitialUser()
    } else {
      setUser(null)
      isGettingInitialUser.value = false
    }

    return
  }

  // no errors, we have a valid user
  if (res.data && res.data.me) {
    const hoppBackendUser = res.data.me

    const hoppUser: HoppUser = {
      uid: hoppBackendUser.uid,
      displayName: hoppBackendUser.displayName,
      email: hoppBackendUser.email,
      photoURL: hoppBackendUser.photoURL,
      // all our signin methods currently guarantees the email is verified
      emailVerified: true,
    }

    setUser(hoppUser)

    isGettingInitialUser.value = false

    authEvents$.next({
      event: "login",
      user: hoppUser,
    })

    return
  }
}

async function refreshToken() {
  const res = await axios.get(
    `${import.meta.env.VITE_BACKEND_API_URL}/auth/refresh`,
    {
      withCredentials: true,
    }
  )

  const isSuccessful = res.status === 200

  if (isSuccessful) {
    authEvents$.next({
      event: "token_refresh",
    })
  }

  return isSuccessful
}

async function sendMagicLink(email: string) {
  const res = await axios.post(
    `${import.meta.env.VITE_BACKEND_API_URL}/auth/signin`,
    {
      email,
    },
    {
      withCredentials: true,
    }
  )

  if (res.data && res.data.deviceIdentifier) {
    setLocalConfig("deviceIdentifier", res.data.deviceIdentifier)
  } else {
    throw new Error("test: does not get device identifier")
  }

  return res.data
}

export const def: AuthPlatformDef = {
  getCurrentUserStream: () => currentUser$,
  getAuthEventsStream: () => authEvents$,
  getProbableUserStream: () => probableUser$,

  getCurrentUser: () => currentUser$.value,
  getProbableUser: () => probableUser$.value,

  getBackendHeaders() {
    return {}
  },
  getGQLClientOptions() {
    return {
      fetchOptions: {
        credentials: "include",
      },
    }
  },

  /**
   * it is not possible for us to know if the current cookie is expired because we cannot access http-only cookies from js
   * hence just returning if the currentUser$ has a value associated with it
   */
  willBackendHaveAuthError() {
    return !currentUser$.value
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onBackendGQLClientShouldReconnect(func) {
    authEvents$.subscribe((event) => {
      if (
        event.event == "login" ||
        event.event == "logout" ||
        event.event == "token_refresh"
      ) {
        func()
      }
    })
  },

  /**
   * we cannot access our auth cookies from javascript, so leaving this as null
   */
  getDevOptsBackendIDToken() {
    return null
  },
  async performAuthInit() {
    const probableUser = JSON.parse(getLocalConfig("login_state") ?? "null")
    probableUser$.next(probableUser)
    await setInitialUser()
  },

  waitProbableLoginToConfirm() {
    return new Promise<void>((resolve, reject) => {
      if (this.getCurrentUser()) {
        resolve()
      }

      if (!probableUser$.value) reject(new Error("no_probable_user"))

      const unwatch = watch(isGettingInitialUser, (val) => {
        if (val === true || val === false) {
          resolve()
          unwatch()
        }
      })
    })
  },

  async signInWithEmail(email: string) {
    await sendMagicLink(email)
  },

  isSignInWithEmailLink(url: string) {
    const urlObject = new URL(url)
    const searchParams = new URLSearchParams(urlObject.search)

    return !!searchParams.get("token")
  },

  async verifyEmailAddress() {
    return
  },
  async signInUserWithGoogle() {
    await signInUserWithGoogleFB()
  },
  async signInUserWithGithub() {
    await signInUserWithGithubFB()
    return undefined
  },
  async signInUserWithMicrosoft() {
    await signInUserWithMicrosoftFB()
  },
  async signInWithEmailLink(email: string, url: string) {
    const urlObject = new URL(url)
    const searchParams = new URLSearchParams(urlObject.search)

    const token = searchParams.get("token")
    const deviceIdentifier = getLocalConfig("deviceIdentifier")

    await axios.post(
      `${import.meta.env.VITE_BACKEND_API_URL}/auth/verify`,
      {
        token: token,
        deviceIdentifier,
      },
      {
        withCredentials: true,
      }
    )
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async setEmailAddress(_email: string) {
    return
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async setDisplayName(name: string) {
    return
  },

  async signOutUser() {
    // if (!currentUser$.value) throw new Error("No user has logged in")

    await logout()

    probableUser$.next(null)
    currentUser$.next(null)
    removeLocalConfig("login_state")

    authEvents$.next({
      event: "logout",
    })
  },

  async processMagicLink() {
    if (this.isSignInWithEmailLink(window.location.href)) {
      const deviceIdentifier = getLocalConfig("deviceIdentifier")

      if (!deviceIdentifier) {
        throw new Error(
          "Device Identifier not found, you can only signin from the browser you generated the magic link"
        )
      }

      await this.signInWithEmailLink(deviceIdentifier, window.location.href)

      removeLocalConfig("deviceIdentifier")
      window.location.href = "/"
    }
  },
}
