import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

export const getJockeys = (filters = {}) =>
  api.get('/jockeys', { params: filters }).then(r => r.data);

export const getJockeyFilters = () =>
  api.get('/jockeys/filters').then(r => r.data);

export const getTrainers = (filters = {}) =>
  api.get('/trainers', { params: filters }).then(r => r.data);

export const getTrainerFilters = () =>
  api.get('/trainers/filters').then(r => r.data);

export const getDrawSearch = (filters = {}) =>
  api.get('/draw/search', { params: filters }).then(r => r.data);

export const getDrawOptions = () =>
  api.get('/draw/options').then(r => r.data);

export const getNextRace = () =>
  api.get('/races/next').then(r => r.data);

export const getRacecard = (date) =>
  api.get('/races/racecard', { params: date ? { date } : {} }).then(r => r.data);

export const getFixtures = () =>
  api.get('/races').then(r => r.data);

export const triggerScrape = (type, body = null) =>
  api.post(`/scrape/${type}`, body, { timeout: 5000 }).then(r => r.data);

export const getHorses = (q) =>
  api.get('/horses', { params: q ? { q } : {} }).then(r => r.data);

export const getHorse = (id) =>
  api.get(`/horses/${id}`).then(r => r.data);

export const scrapeHorse = (horseId) =>
  api.post(`/scrape/horse/${horseId}`).then(r => r.data);

export const scrapeCourseTime = () =>
  api.post('/scrape/coursetime').then(r => r.data);

export const getCourseTime = (params = {}) =>
  api.get('/coursetime', { params }).then(r => r.data);

export const getCourseRecords = (params = {}) =>
  api.get('/coursetime/records', { params }).then(r => r.data);

export const scrapeHorses = () =>
  api.post('/scrape/horses').then(r => r.data);

export const getTrackworkByHorse = (name, limit = 5) =>
  api.get('/trackwork/horse', { params: { name, limit }, timeout: 120000 }).then(r => r.data);

export default api;
