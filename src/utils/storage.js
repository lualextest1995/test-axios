const localStorageHandle = {
  getItem(key) {
    return localStorage.getItem(key)
  },
}

export { localStorageHandle }
