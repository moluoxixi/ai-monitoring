import { ref } from 'vue'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'ai-monitor-theme'
const storedTheme = (): Theme | null => {
  const value = window.localStorage.getItem(STORAGE_KEY)
  return value === 'dark' || value === 'light' ? value : null
}

const preferredTheme = (): Theme => storedTheme()
  || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')

const applyTheme = (value: Theme): void => {
  document.documentElement.dataset.theme = value
  document.documentElement.style.colorScheme = value
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', value === 'light' ? '#f2eee6' : '#080d0c')
}

const theme = ref<Theme>(preferredTheme())
applyTheme(theme.value)

export const useTheme = () => {
  const toggleTheme = () => {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
    window.localStorage.setItem(STORAGE_KEY, theme.value)
    applyTheme(theme.value)
  }

  return { theme, toggleTheme }
}
