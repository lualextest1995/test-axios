import Cookies from 'js-cookie'

const get = (name) => {
  return Cookies.get(name)
}

const remove = (name) => {
  return Cookies.remove(name)
}

export default {
  get,
  remove,
}
