<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import { CircleCheckFilled, InfoFilled, Star, WarningFilled } from '@element-plus/icons-vue'
import type { TastingConclusion } from '@/types/tasting'

/** 等级口径：优先使用结论，其次按评分区间推断 */
const props = withDefaults(
  defineProps<{
    /** 品评结论：优 / 合格 / 待改进 */
    conclusion?: TastingConclusion | ''
    /** 品评评分 1-10，未传 conclusion 时用于推断等级 */
    score?: number
    /** 是否显示图标 */
    icon?: boolean
    /** 是否使用描边风格 */
    plain?: boolean
    /** 尺寸 */
    size?: 'default' | 'small' | 'large'
    /** 附加文案，如「均分 8.5」 */
    suffix?: string
  }>(),
  {
    conclusion: '',
    score: undefined,
    icon: true,
    plain: false,
    size: 'default',
    suffix: ''
  }
)

type Tone = 'excellent' | 'pass' | 'improve' | 'none'

const toneColor: Record<Tone, string> = {
  excellent: '#1e8449',
  pass: '#2f6fb0',
  improve: '#c0392b',
  none: '#909399'
}

const toneBg: Record<Tone, string> = {
  excellent: '#eaf6ee',
  pass: '#eaf1f9',
  improve: '#fdecea',
  none: '#f2f0ed'
}

const toneLabel: Record<Tone, string> = {
  excellent: '优',
  pass: '合格',
  improve: '待改进',
  none: '未评'
}

const tone = computed<Tone>(() => {
  if (props.conclusion === '优') return 'excellent'
  if (props.conclusion === '合格') return 'pass'
  if (props.conclusion === '待改进') return 'improve'
  if (typeof props.score === 'number') {
    if (props.score >= 8.5) return 'excellent'
    if (props.score >= 6) return 'pass'
    return 'improve'
  }
  return 'none'
})

const toneIcon = computed<Component>(() => {
  if (tone.value === 'excellent') return CircleCheckFilled
  if (tone.value === 'pass') return Star
  if (tone.value === 'improve') return WarningFilled
  return InfoFilled
})

const label = computed(() => (props.conclusion ? props.conclusion : toneLabel[tone.value]))

const style = computed(() => ({
  color: props.plain ? toneColor[tone.value] : '#ffffff',
  backgroundColor: props.plain ? toneBg[tone.value] : toneColor[tone.value],
  borderColor: toneColor[tone.value]
}))

const scoreText = computed(() =>
  typeof props.score === 'number' ? `${props.score.toFixed(1)} 分` : ''
)
</script>

<template>
  <span class="grade-tag" :class="[`is-${size}`, { 'is-plain': plain }]" :style="style">
    <el-icon v-if="icon" class="grade-tag__icon">
      <component :is="toneIcon" />
    </el-icon>
    <span class="grade-tag__text">{{ label }}</span>
    <span v-if="scoreText" class="grade-tag__score">· {{ scoreText }}</span>
    <span v-if="suffix" class="grade-tag__suffix">{{ suffix }}</span>
  </span>
</template>

<style scoped>
.grade-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  white-space: nowrap;
}

.grade-tag.is-small {
  padding: 0 8px;
  font-size: 12px;
  line-height: 18px;
}

.grade-tag.is-large {
  padding: 4px 14px;
  font-size: 15px;
  line-height: 24px;
}

.grade-tag__icon {
  font-size: 13px;
}

.grade-tag__score,
.grade-tag__suffix {
  font-weight: 400;
  opacity: 0.92;
}
</style>
