import axios from 'axios'
import Cookies from '@/utils/cookies'
import JWT from '@/utils/jwt'
import { localStorageHandle } from '@/utils/storage'

const magicWord = {
  ACCESS_TOKEN: 'access_token',
  REFRESH_TOKEN: 'refresh_token',
  X_ACCESS_TOKEN: 'x-access-token',
  X_REFRESH_TOKEN: 'x-refresh-token',
  X_LOCALE: 'x-locale',
  LANGUAGE: 'language',
  CURRENCY: 'currency',
}

const baseURL = 'https://jsonplaceholder.typicode.com'

const axiosInstance = axios.create({
  baseURL,
  timeout: 24 * 60 * 60 * 1000, // 24h
  withCredentials: false,
  headers: {
    'Content-Type': 'application/json;charset=UTF-8',
  },
})

axiosInstance.interceptors.request.use((config) =>
  applyPipeline(config, [
    checkNetwork,
    checkAuth,
    preprocessRequest,
    setCurrency,
    setLanguage,
    setAccessToken,
  ]),
)

axiosInstance.interceptors.response.use(
  (response) => {
    const context = {
      response,
      data: response.data,
    }
    return applyPipeline(context, [updateAuth, parseBinaryResponse]).then((ctx) => ctx.data)
  },
  (error) => {
    if (error.isOfflineError) {
      alert(error.message)
      return Promise.reject(error)
    }
    if (error.isUnauthorizedError) {
      Cookies.remove(magicWord.ACCESS_TOKEN)
      Cookies.remove(magicWord.REFRESH_TOKEN)
      window.location.href = '/login'
      alert(error.message)
      return Promise.reject(error)
    }
    if (error.isAccessTokenExpiredError) {
      // 刷新 token 流程(todo)
      alert(error.message + '，請重新整理頁面')
      return Promise.reject(error)
    }
    return Promise.reject(error)
  },
)

export default axiosInstance

async function applyPipeline(input, fns) {
  for (const fn of fns) {
    input = await fn(input)
  }
  return input
}

function checkNetwork(config) {
  if (!navigator.onLine) {
    throw new OfflineError()
  }
  return config
}

function checkAuth(config) {
  const accessToken = Cookies.get(magicWord.ACCESS_TOKEN) || null
  const refreshToken = Cookies.get(magicWord.REFRESH_TOKEN) || null
  if (!accessToken || !refreshToken) throw new UnauthorizedError()
  const accessTokenIsExpired = JWT.isExpired(accessToken)
  const refreshTokenIsExpired = JWT.isExpired(refreshToken)
  if (accessTokenIsExpired && refreshTokenIsExpired) throw new UnauthorizedError()
  if (accessTokenIsExpired && !refreshTokenIsExpired) throw new AccessTokenExpiredError()
  return config
}

function preprocessRequest(config) {
  if (config.isPreprocessing) return config

  const method = config.method?.toLowerCase()
  const isWrite = ['post', 'put', 'patch', 'delete'].includes(method)

  if (isWrite) {
    config.params = undefined
  } else {
    config.params = config.data
    config.data = undefined
  }

  config.isPreprocessing = true
  return config
}

function setCurrency(config) {
  const currency = localStorageHandle.getItem(magicWord.CURRENCY)
  if (!currency) return config
  config.headers[magicWord.CURRENCY] = currency
  return config
}

function setLanguage(config) {
  const lang = localStorageHandle.getItem(magicWord.LANGUAGE)
  if (!lang) return config
  config.headers[magicWord.X_LOCALE] = lang
  return config
}

function setAccessToken(config) {
  const accessToken = Cookies.get(magicWord.ACCESS_TOKEN) || null
  if (!accessToken) return config
  config.headers[magicWord.X_ACCESS_TOKEN] = accessToken
  return config
}

function updateAuth(context) {
  const { headers } = context.response
  const accessToken = headers[magicWord.X_ACCESS_TOKEN] || null
  const refreshToken = headers[magicWord.X_REFRESH_TOKEN] || null
  if (accessToken && refreshToken) {
    Cookies.set(magicWord.ACCESS_TOKEN, accessToken)
    Cookies.set(magicWord.REFRESH_TOKEN, refreshToken)
  }
  return context
}

function parseBinaryResponse(context) {
  const { data } = context.response
  const isBlob = data instanceof Blob
  const isArrayBuffer = data instanceof ArrayBuffer
  if (isBlob || isArrayBuffer) {
    context.data = context.response
  }
  return context
}

class BaseHttpError extends Error {
  constructor(message, name, flags = {}) {
    super(message)
    this.name = name
    Object.assign(this, flags, { isHandled: true })
  }
}

class OfflineError extends BaseHttpError {
  constructor(message = '設備目前離線，請檢查網路連線') {
    super(message, 'OfflineError', { isOfflineError: true })
  }
}

class UnauthorizedError extends BaseHttpError {
  constructor(message = '未授權，請重新登入') {
    super(message, 'UnauthorizedError', { isUnauthorizedError: true })
  }
}

class AccessTokenExpiredError extends BaseHttpError {
  constructor(message = 'Access token 已過期') {
    super(message, 'AccessTokenExpiredError', { isAccessTokenExpiredError: true })
  }
}
