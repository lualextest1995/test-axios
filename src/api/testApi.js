import http from '../utils/request'

export function getPosts() {
  return http.request({
    url: '/posts',
    method: 'get',
  })
}

export function getComments(data) {
  return http.request({
    url: '/comments',
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
