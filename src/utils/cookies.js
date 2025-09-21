import Cookies from 'js-cookie'

const get = (name) => {
  return Cookies.get(name)
}

const set = (name, value, options = {}) => {
  return Cookies.set(name, value, options)
}

const remove = (name) => {
  return Cookies.remove(name)
}

export default {
  get,
  set,
  remove,
}
