import http from '../utils/request'

export function getPosts() {
  return http.request({
    url: '/postsasdsad',
    method: 'get',
    // __retryCount: 1, // 自定义配置，重试次数
  })
}

export function getComments(data) {
  return http.request({
    url: '/comments9999',
    method: 'get',
    data,
  })
}

export function createPost(data) {
  return http.request({
    url: '/posts',
    method: 'post',
    data,
  })
}
