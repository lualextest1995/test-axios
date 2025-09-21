<script setup>
import { getPosts, getComments, createPost } from '@/api/testApi'

async function getData() {
  try {
    const res = await getPosts()
    console.log(res)
  } catch (error) {
    if (error.isHandled) return
    console.log(error)
  }
}

async function getCommentsData() {
  try {
    const data = { postId: 1 }
    const res = await getComments(data)
    console.log(res)
  } catch (error) {
    if (error.isHandled) return
    console.log(error)
  }
}

async function createData() {
  try {
    const data = { title: 'foo', body: 'bar', userId: 1 }
    const res = await createPost(data)
    console.log(res)
  } catch (error) {
    if (error.isHandled) return
    console.log(error)
  }
}

async function test() {
  try {
    getData()
    getCommentsData()
  } catch (error) {
    console.log(error)
  }
}
</script>

<template>
  <h1>You did it!</h1>
  <p>
    Visit <a href="https://vuejs.org/" target="_blank" rel="noopener">vuejs.org</a> to read the
    documentation
    <button @click="getData">Get Data</button>
    <button @click="getCommentsData">Get Comments</button>
    <button @click="createData">Create Data</button>
    <button @click="test">Test</button>
  </p>
</template>

<style scoped></style>
