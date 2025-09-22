import axios from 'axios'
import Cookies from '/@/utils/cookies'
import router from '/@/router'
import JWT from '/@/utils/jwt'
import { ElMessage } from 'element-plus'
import { TOKEN } from '/@/config/constant'
import { localStorageHandle } from '/@/utils/storage'

/** ---------- QueueManager ---------- */
class QueueManager {
  constructor() {
    this.queue = []
  }

  enqueue(config) {
    return new Promise((resolve, reject) => {
      this.queue.push({ config, resolve, reject })
      console.log('加入失敗請求:', config.url, '目前佇列長度:', this.queue.length)
    })
  }

  async resolveAll(instance) {
    console.log('開始處理失敗的請求佇列，長度:', this.queue.length)
    for (const task of this.queue) {
      if (isLogout) {
        task.reject(new UnauthorizedError('未授權，請重新登入', task.config))
        continue
      }
      try {
        const retryConfig = { ...task.config, _internalRetry: true }
        const res = await instance(retryConfig)
        task.resolve(res)
      } catch (err) {
        if (err.status === 401 || err.response?.status === 401) {
          task.reject(new UnauthorizedError('登入已失效，請重新登入', task.config))
          isLogout = true
        } else {
          task.reject(err)
        }
      }
    }
    this.clear()
    isLogout = false
    console.log('失敗的請求佇列處理完成。')
  }

  rejectAll(err) {
    this.queue.forEach((task) => task.reject(err))
    this.clear()
  }

  clear() {
    this.queue = []
  }
}

/** ---------- 錯誤類別 ---------- */
class BaseHttpError extends Error {
  constructor(message, name, config, flags = {}) {
    super(message)
    this.name = name
    this.config = config
    this.handled = true
    Object.assign(this, flags)
  }
}

class OfflineError extends BaseHttpError {
  constructor(message = '設備目前離線，請檢查網路連線', config) {
    super(message, 'OfflineError', config, { isOfflineError: true })
  }
}

class UnauthorizedError extends BaseHttpError {
  constructor(message = '未授權，請重新登入', config) {
    super(message, 'UnauthorizedError', config, { isUnauthorizedError: true })
  }
}

class IsRefreshingTokenError extends BaseHttpError {
  constructor(message = '正在刷新 token，請稍後再試', config) {
    super(message, 'IsRefreshingTokenError', config, { isRefreshingTokenError: true })
  }
}

/** ---------- 常數定義 ---------- */
const magicWord = {
  ACCESS_TOKEN: 'access_token',
  REFRESH_TOKEN: 'refresh_token',
  X_ACCESS_TOKEN: 'x-access-token',
  X_REFRESH_TOKEN: 'x-refresh-token',
  X_LOCALE: 'x-locale',
  LANGUAGE: 'language',
  CURRENCY: 'currency',
}

const baseURL = '/api'
const failedQueue = new QueueManager()
let isRefreshing = false
let isLogout = false
let refreshAttempts = 0
let lastResetTime = Date.now()
const MAX_REFRESH_ATTEMPTS = 5 // 1分鐘內最多5次
const RESET_INTERVAL = 60 * 1000 // 1分鐘

/** ---------- 已知 HTTP 狀態碼錯誤訊息 ---------- */
const knownErrorMessage = Object.freeze({
  401: '登入已失效，請重新登入',
  408: '請求逾時，請稍後再試',
  429: '操作過於頻繁，請稍候重試',
  500: 'Server 錯誤，請稍後再試',
  504: '閘道逾時，請稍後再試',
})

/** ---------- axios instance ---------- */
const axiosInstance = axios.create({
  baseURL,
  timeout: 24 * 60 * 60 * 1000,
  withCredentials: false,
  headers: { 'Content-Type': 'application/json;charset=UTF-8' },
})

/** ---------- Request Interceptor ---------- */
axiosInstance.interceptors.request.use(
  (config) =>
    applyPipeline(config, [
      checkNetwork,
      checkIsRefreshing,
      preprocessRequest,
      setCurrency,
      setLanguage,
      setAccessToken,
    ]),
  (error) => Promise.reject(error),
)

/** ---------- Response Interceptor ---------- */
axiosInstance.interceptors.response.use(
  async (response) => {
    const context = { response, data: response.data }
    return applyPipeline(context, [updateAuth, parseBinaryResponse]).then((ctx) => ctx.data)
  },
  async (error) => {
    const config = error.config || null
    const status = error.response?.status || null
    const traceId = error.response?.data?.traceId

    // 附加 traceId 到錯誤訊息，方便追蹤
    if (traceId) {
      error.traceId = traceId
      error.message = (error.message || '未知錯誤') + ` (${traceId})`
    }

    // 解析 Blob 格式錯誤訊息
    await parseBlobError(error)

    // 已重試過 → 清除憑證
    if (config && config._internalRetry) {
      resetAuth('重試失敗', error)
      return Promise.reject(error)
    }

    // 正在刷新 token，加入佇列等待
    if (error.isRefreshingTokenError) {
      return failedQueue.enqueue(config)
    }

    // 沒權限或 token 過期，嘗試刷新 token
    if (status === 401 || error.isUnauthorizedError) {
      checkAndResetCounter() // 檢查是否需要重置
      refreshAttempts++
      // 超過限制直接登出
      if (refreshAttempts > MAX_REFRESH_ATTEMPTS) {
        console.warn(`refresh token 1分鐘內嘗試 ${refreshAttempts} 次，強制登出`)
        refreshAttempts = 0
        lastResetTime = Date.now()
        resetAuth('refresh token 頻率過高', error)
        return Promise.reject(new UnauthorizedError('操作過於頻繁，請重新登入'))
      }

      const queuePromise = failedQueue.enqueue(config)
      if (!isRefreshing) {
        isRefreshing = true
        try {
          const res = await refreshToken()
          const { headers } = res
          const newAccessToken = headers[magicWord.X_ACCESS_TOKEN] || null
          const newRefreshToken = headers[magicWord.X_REFRESH_TOKEN] || null
          const refreshExp = JWT.getExpiration(newRefreshToken)

          Cookies.set(magicWord.ACCESS_TOKEN, newAccessToken, { expires: undefined })
          Cookies.set(magicWord.REFRESH_TOKEN, newRefreshToken, { expires: refreshExp })
          console.log('Token 刷新成功:', newAccessToken, newRefreshToken)

          await failedQueue.resolveAll(axiosInstance)
        } catch (err) {
          resetAuth('刷新 token 失敗', err)
          failedQueue.rejectAll(err)
        } finally {
          isRefreshing = false
        }
      }
      return queuePromise
    }

    // 處理已知的 HTTP 錯誤
    if (handleKnownHttpErrors(error)) {
      return Promise.reject(error)
    }

    return Promise.reject(error)
  },
)

export default axiosInstance

/** ---------- Pipeline 函數 ---------- */
async function applyPipeline(input, fns) {
  for (const fn of fns) {
    input = await fn(input)
  }
  return input
}

// 檢查是否正在刷新 token
function checkIsRefreshing(config) {
  if (isRefreshing) throw new IsRefreshingTokenError('正在刷新 token，請稍後再試', config)
  return config
}

// 檢查網路狀態
function checkNetwork(config) {
  if (!navigator.onLine) throw new OfflineError('設備目前離線，請檢查網路連線', config)
  return config
}

// 處理 URL 模板參數，例如 /api/users/{userId}
function processUrlTemplate(config) {
  if (!config.url || typeof config.data !== 'object' || config.data === null) return config
  const urlParams = {}
  config.url = config.url.replace(/\{(\w+)\}/g, (match, key) => {
    if (key in config.data) {
      urlParams[key] = config.data[key]
      return config.data[key]
    }
    return match
  })
  if (config.removeUrlParams !== false) {
    config.data = Object.fromEntries(Object.entries(config.data).filter(([k]) => !(k in urlParams)))
  }
  return config
}

// 預處理請求，將 data 與 params 分流
function preprocessRequest(config) {
  if (config.isPreprocessing) return config
  const method = config.method?.toLowerCase()
  const isWrite = ['post', 'put', 'patch', 'delete'].includes(method)

  config = processUrlTemplate(config)

  if (isWrite) {
    config.params = undefined
  } else {
    config.params = config.data
    config.data = undefined
  }

  config.isPreprocessing = true
  return config
}

// 設定貨幣標頭
function setCurrency(config) {
  const currency = localStorageHandle.getItem(magicWord.CURRENCY)
  if (currency) config.headers[magicWord.CURRENCY] = currency
  return config
}

// 設定語言標頭
function setLanguage(config) {
  const lang = localStorageHandle.getItem(magicWord.LANGUAGE)
  if (lang) config.headers[magicWord.X_LOCALE] = lang
  return config
}

// 設定 Access Token 標頭
function setAccessToken(config) {
  const accessToken = Cookies.get(magicWord.ACCESS_TOKEN)
  if (accessToken) config.headers[magicWord.X_ACCESS_TOKEN] = accessToken
  return config
}

// 更新驗證資訊
function updateAuth(context) {
  const { headers } = context.response
  const accessToken = headers[magicWord.X_ACCESS_TOKEN]
  const refreshToken = headers[magicWord.X_REFRESH_TOKEN]
  if (accessToken && refreshToken) {
    const refreshExp = JWT.getExpiration(refreshToken)
    Cookies.set(magicWord.ACCESS_TOKEN, accessToken, { expires: undefined })
    Cookies.set(magicWord.REFRESH_TOKEN, refreshToken, { expires: refreshExp })
  }
  return context
}

// 解析二進位回應
function parseBinaryResponse(context) {
  const { data } = context.response
  if (data instanceof Blob || data instanceof ArrayBuffer) {
    context.data = context.response
  }
  return context
}

/** ---------- 工具函式 ---------- */
function resetAuth(reason, error = null) {
  console.warn('清除驗證資訊:', reason)
  Cookies.remove(magicWord.ACCESS_TOKEN)
  Cookies.remove(magicWord.REFRESH_TOKEN)
  Cookies.remove(TOKEN)
  isLogout = true
  errorHandler(error || new UnauthorizedError('登入已失效，請重新登入'))
  if (router.currentRoute.value.path !== '/login') {
    router.push('/login')
  }
}

// 刷新 token
function refreshToken() {
  const access = Cookies.get(magicWord.ACCESS_TOKEN) || 'noAccess'
  const refresh = Cookies.get(magicWord.REFRESH_TOKEN) || 'noRefresh'
  const isLogin = Cookies.get(TOKEN) === 'token'
  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
    [magicWord.X_ACCESS_TOKEN]: isLogin ? access : undefined,
    [magicWord.X_REFRESH_TOKEN]: isLogin ? refresh : undefined,
  }
  return axios.request({
    baseURL,
    url: '/refreshToken',
    method: 'get',
    headers,
  })
}

// 解析 Blob 格式錯誤訊息
async function parseBlobError(error) {
  const isBlob = typeof Blob !== 'undefined' && error.response?.data instanceof Blob
  if (!isBlob) return error

  try {
    const text = await error.response.data.text()
    let responseJson

    try {
      responseJson = JSON.parse(text)
    } catch {
      responseJson = { message: text }
    }

    // 確保 traceId 存在
    if (!responseJson.traceId) {
      responseJson.traceId = 'N/A'
    }

    // 塞回 response.data
    error.response.data = responseJson

    // 若沒有 HTTP status，但有 code，則補上
    if (responseJson.code && !error.response.status) {
      error.response.status = responseJson.code
    }

    // 🔹 保證 error.message 帶 traceId
    error.message =
      (responseJson.message || error.message || '未知錯誤') + ` (${responseJson.traceId})`
    error.traceId = responseJson.traceId
  } catch (e) {
    console.warn('解析 Blob 錯誤時發生例外:', e)
    error.response.data = { message: '未知的 Blob 錯誤', traceId: 'N/A' }
    error.message = '未知的 Blob 錯誤 (N/A)'
    error.traceId = 'N/A'
  }

  return error
}

// 處理已知的 HTTP 錯誤
function handleKnownHttpErrors(error) {
  const status = error.response?.status
  if (!status || !knownErrorMessage[status]) return false

  errorHandler(error)
  return true
}

// 檢查並重置 refresh token 計數器
function checkAndResetCounter() {
  const now = Date.now()
  if (now - lastResetTime >= RESET_INTERVAL) {
    if (refreshAttempts > 0) {
      console.log('重置 refresh token 計數器')
    }
    refreshAttempts = 0
    lastResetTime = now
  }
}

/** ---------- 統一錯誤處理 ---------- */
/**
 * 統一處理錯誤訊息
 * @param {Error|BaseHttpError} error 錯誤物件
 * @param {Object} [options] 選項
 * @param {boolean} [options.silent=false] 是否靜默（不顯示 UI）
 */
function errorHandler(error, options = {}) {
  if (!error || error.handled) return
  const { silent = false } = options

  const status = error.response?.status
  let message = knownErrorMessage[status] || error.message || '未知錯誤'

  if (!silent) {
    ElMessage.error(message)
  }

  error.message = message
  error.handled = true
}
