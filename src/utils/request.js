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

let isRefreshing = false
let failedQueue = []

const axiosInstance = axios.create({
  baseURL,
  timeout: 24 * 60 * 60 * 1000, // 24h
  withCredentials: false,
  headers: {
    'Content-Type': 'application/json;charset=UTF-8',
  },
})

axiosInstance.interceptors.request.use(
  (config) =>
    applyPipeline(config, [
      checkNetwork,
      checkIsRefreshing,
      checkAuth,
      preprocessRequest,
      setCurrency,
      setLanguage,
      setAccessToken,
      (config) => {
        // console.log('Request config:', config)
        return config
      },
    ]),
  (error) => Promise.reject(error),
)

axiosInstance.interceptors.response.use(
  (response) => {
    const context = {
      response,
      data: response.data,
    }
    return applyPipeline(context, [updateAuth, parseBinaryResponse]).then((ctx) => ctx.data)
  },
  async (error) => {
    const config = error.config || null
    const status = error.response?.status || null

    // 是否可以重试
    if (config && config.isRetry) {
      return Promise.reject(error)
    }

    // 刷新中，將請求加入佇列
    if (error.isRefreshingTokenError) {
      console.log('請求因正在刷新 token 而被加入佇列:', config.url)
      return addFailedRequestToQueue(error)
    }

    // 沒權限，且非刷新中，開始刷新 token
    if (status === 404 || error.isUnauthorizedError) {
      // 將當前請求加入佇列
      addFailedRequestToQueue(error)
      if (!isRefreshing) {
        isRefreshing = true
        try {
          await refreshToken()
          processFailedQueue()
        } catch (err) {
          clearAuth()
          failedQueue = []
          alert('刷新 token 失败，请重新登录')
          window.location.href = '/login'
        } finally {
          isRefreshing = false
        }
      }
    }

    return Promise.reject(error)
  },
)

export default axiosInstance

// 串接函式管線
async function applyPipeline(input, fns) {
  for (const fn of fns) {
    input = await fn(input)
  }
  return input
}

// 檢查是否正在刷新 token
function checkIsRefreshing(config) {
  console.log('config url:', config.url, 'isRefreshing:', isRefreshing)
  if (isRefreshing) {
    throw new IsRefreshingTokenError('正在刷新 token，請稍後再試', config)
  }
  return config
}

// 檢查網路狀態
function checkNetwork(config) {
  if (!navigator.onLine) {
    throw new OfflineError('設備目前離線，請檢查網路連線', config)
  }
  return config
}

// 檢查驗證狀態
function checkAuth(config) {
  // 默認需要驗證
  const needAuth = config.needAuth || true
  if (!needAuth) return config
  const accessToken = Cookies.get(magicWord.ACCESS_TOKEN) || null
  const refreshToken = Cookies.get(magicWord.REFRESH_TOKEN) || null
  if (!accessToken || !refreshToken) throw new UnauthorizedError('未授權，請重新登入', config)
  // const accessTokenIsExpired = JWT.isExpired(accessToken)
  // const refreshTokenIsExpired = JWT.isExpired(refreshToken)
  // if (accessTokenIsExpired && refreshTokenIsExpired) throw new UnauthorizedError()
  // if (accessTokenIsExpired && !refreshTokenIsExpired) throw new AccessTokenExpiredError()
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
  constructor(message = '設備目前離線，請檢查網路連線', config) {
    super(message, 'OfflineError', { isOfflineError: true })
    this.config = config
  }
}

class UnauthorizedError extends BaseHttpError {
  constructor(message = '未授權，請重新登入', config) {
    super(message, 'UnauthorizedError', { isUnauthorizedError: true })
    this.config = config
  }
}

class AccessTokenExpiredError extends BaseHttpError {
  constructor(message = 'Access token 已過期', config) {
    super(message, 'AccessTokenExpiredError', { isAccessTokenExpiredError: true })
    this.config = config
  }
}

class IsRefreshingTokenError extends BaseHttpError {
  constructor(message = '正在刷新 token，請稍後再試', config) {
    super(message, 'IsRefreshingTokenError', { isRefreshingTokenError: true })
    this.config = config
  }
}

// 清除驗證資訊
function clearAuth() {
  Cookies.remove(magicWord.ACCESS_TOKEN)
  Cookies.remove(magicWord.REFRESH_TOKEN)
}

// 模擬刷新 token 的函式
function refreshToken() {
  // 模拟刷新 token 的 API 调用
  return new Promise((resolve) => {
    setTimeout(() => {
      const newAccessToken = 'newAccessToken' + Date.now()
      const newRefreshToken = 'newRefreshToken' + Date.now()
      Cookies.set(magicWord.ACCESS_TOKEN, newAccessToken)
      Cookies.set(magicWord.REFRESH_TOKEN, newRefreshToken)
      resolve({ accessToken: newAccessToken, refreshToken: newRefreshToken })
    }, 5000) // 模拟网络延迟
  })
}

// 將失敗的請求加入佇列
function addFailedRequestToQueue(error) {
  const config = error.config
  console.log('新增失敗的請求到佇列中:', config.url)
  return new Promise((resolve, reject) => {
    failedQueue.push({ resolve, reject, config })
    console.log('目前失敗的請求佇列長度:', failedQueue.length)
  })
}

// 處理失敗的請求佇列
async function processFailedQueue() {
  console.log('開始處理失敗的請求佇列，長度:', failedQueue.length)
  for (const req of failedQueue) {
    try {
      const config = { ...req.config, isRetry: true }
      const response = await axiosInstance(config)
      req.resolve(response)
    } catch (err) {
      req.reject(err)
    }
  }
  failedQueue = []
  console.log('失敗的請求佇列處理完成。')
}
