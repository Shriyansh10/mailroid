"use client";

import { trpc } from "@web/trpc/client";

// ── Categories ────────────────────────────────────────────────────────

export const useMailTemplateCategories = () => {
  return trpc.mailTemplates.categories.useQuery();
};

export const useCreateCategory = () => {
  const utils = trpc.useUtils();
  const {
    mutateAsync: createCategoryAsync,
    mutate: createCategoryFn,
    error,
    isError,
    isIdle,
    isSuccess,
    isPending,
    reset,
    status,
  } = trpc.mailTemplates.createCategory.useMutation({
    onSuccess: () => {
      void utils.mailTemplates.categories.invalidate();
    },
  });

  return {
    createCategoryAsync,
    createCategory: createCategoryFn,
    error,
    isError,
    isIdle,
    isSuccess,
    isPending,
    reset,
    status,
  };
};

export const useDeleteCategory = () => {
  const utils = trpc.useUtils();
  const {
    mutateAsync: deleteCategoryAsync,
    mutate: deleteCategoryFn,
    error,
    isError,
    isIdle,
    isSuccess,
    isPending,
    reset,
    status,
  } = trpc.mailTemplates.deleteCategory.useMutation({
    onSuccess: () => {
      // Deleting a category cascades its templates, so both caches (and the
      // count banner) go stale together.
      void utils.mailTemplates.categories.invalidate();
      void utils.mailTemplates.templates.invalidate();
      void utils.mailTemplates.templateCount.invalidate();
    },
  });

  return {
    deleteCategoryAsync,
    deleteCategory: deleteCategoryFn,
    error,
    isError,
    isIdle,
    isSuccess,
    isPending,
    reset,
    status,
  };
};

// ── Templates ─────────────────────────────────────────────────────────

export const useMailTemplates = (categoryId?: string) => {
  return trpc.mailTemplates.templates.useQuery({ categoryId });
};

export const useTemplateCount = () => {
  return trpc.mailTemplates.templateCount.useQuery();
};

export const useCreateTemplate = () => {
  const utils = trpc.useUtils();
  const {
    mutateAsync: createTemplateAsync,
    mutate: createTemplateFn,
    error,
    isError,
    isIdle,
    isSuccess,
    isPending,
    reset,
    status,
  } = trpc.mailTemplates.createTemplate.useMutation({
    onSuccess: () => {
      void utils.mailTemplates.templates.invalidate();
      void utils.mailTemplates.templateCount.invalidate();
    },
  });

  return {
    createTemplateAsync,
    createTemplate: createTemplateFn,
    error,
    isError,
    isIdle,
    isSuccess,
    isPending,
    reset,
    status,
  };
};

export const useUpdateTemplate = () => {
  const utils = trpc.useUtils();
  const {
    mutateAsync: updateTemplateAsync,
    mutate: updateTemplateFn,
    error,
    isError,
    isIdle,
    isSuccess,
    isPending,
    reset,
    status,
  } = trpc.mailTemplates.updateTemplate.useMutation({
    onSuccess: () => {
      void utils.mailTemplates.templates.invalidate();
    },
  });

  return {
    updateTemplateAsync,
    updateTemplate: updateTemplateFn,
    error,
    isError,
    isIdle,
    isSuccess,
    isPending,
    reset,
    status,
  };
};

export const useDeleteTemplate = () => {
  const utils = trpc.useUtils();
  const {
    mutateAsync: deleteTemplateAsync,
    mutate: deleteTemplateFn,
    error,
    isError,
    isIdle,
    isSuccess,
    isPending,
    reset,
    status,
  } = trpc.mailTemplates.deleteTemplate.useMutation({
    onSuccess: () => {
      void utils.mailTemplates.templates.invalidate();
      void utils.mailTemplates.templateCount.invalidate();
    },
  });

  return {
    deleteTemplateAsync,
    deleteTemplate: deleteTemplateFn,
    error,
    isError,
    isIdle,
    isSuccess,
    isPending,
    reset,
    status,
  };
};
