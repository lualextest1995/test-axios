import { jwtDecode } from 'jwt-decode'
import dayjs from 'dayjs'

const isExpired = (token) => {
  if (!token) return true
  try {
    const { exp } = jwtDecode(token)
    if (!exp) return true
    const now = dayjs().unix()
    return now >= exp
  } catch (error) {
    return true
  }
}

export default {
  isExpired,
}
